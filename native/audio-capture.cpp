/**
 * audio-capture.exe — Process-exclusive WASAPI loopback capture.
 *
 * Captures all system audio EXCEPT audio from the specified process tree.
 * Uses Windows 10 21H2+ WASAPI ActivateAudioInterfaceAsync with
 * PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE.
 *
 * This solves the screen share echo problem: when Electron captures system
 * audio via loopback, it also captures voice chat audio from remote
 * participants (played through speakers). The echo loop:
 *   Remote voice -> speakers -> loopback -> screen share -> remote hears self
 *
 * By excluding our own process tree, voice chat audio is filtered out
 * at the OS level (WASAPI session isolation), but all other system audio
 * (games, music, other apps) is still captured.
 *
 * Usage: audio-capture.exe <PID>
 *   PID: Process ID to exclude (Electron's main process PID)
 *
 * Output format (stdout, binary):
 *   Bytes 0-11:  Header — sampleRate(u32) channels(u16) bitsPerSample(u16) formatTag(u32)
 *   Bytes 12+:   Raw interleaved PCM samples (typically float32 stereo 48kHz)
 *
 * Shutdown: Close stdin pipe or send CTRL_C_EVENT.
 *
 * Requirements:
 *   - Windows 10 Build 20348+ (Windows 10 21H2 / Windows 11)
 *   - Compile: cl.exe /EHsc /O2 audio-capture.cpp /Fe:audio-capture.exe ole32.lib
 */

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX

#include <windows.h>
#include <initguid.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <stdio.h>
#include <stdlib.h>
#include <io.h>
#include <fcntl.h>

// ═══════════════════════════════════════════════════════════════════════
// Manual definitions for process loopback.
//
// These structures were introduced in Windows SDK 10.0.22000.0+ but the
// runtime support exists on Windows 10 21H2+ (build 20348). Since we
// compile with SDK 10.0.19041.0, we define them manually here. The
// binary layout matches the official SDK headers exactly.
// ═══════════════════════════════════════════════════════════════════════

#ifndef VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK
#define VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK L"VAD\\Process_Loopback"
#endif

// AUDIOCLIENT_ACTIVATION_TYPE — how to activate the audio interface.
// DEFAULT uses a real audio device; PROCESS_LOOPBACK creates a virtual
// capture device that taps into a specific process's audio session.
typedef enum AUDIOCLIENT_ACTIVATION_TYPE_ENUM {
    AC_ACTIVATION_TYPE_DEFAULT          = 0,
    AC_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1
} AUDIOCLIENT_ACTIVATION_TYPE_ENUM;

// PROCESS_LOOPBACK_MODE — include or exclude the target process tree.
// INCLUDE: capture ONLY the target process's audio.
// EXCLUDE: capture ALL system audio EXCEPT the target process tree.
typedef enum PROCESS_LOOPBACK_MODE_ENUM {
    PL_MODE_INCLUDE_TARGET_PROCESS_TREE = 0,
    PL_MODE_EXCLUDE_TARGET_PROCESS_TREE = 1
} PROCESS_LOOPBACK_MODE_ENUM;

// Process loopback parameters embedded in the activation params.
typedef struct AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS_S {
    DWORD                       TargetProcessId;
    PROCESS_LOOPBACK_MODE_ENUM  ProcessLoopbackMode;
} AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS_S;

// Top-level activation parameters passed to ActivateAudioInterfaceAsync.
typedef struct AUDIOCLIENT_ACTIVATION_PARAMS_S {
    AUDIOCLIENT_ACTIVATION_TYPE_ENUM ActivationType;
    union {
        AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS_S ProcessLoopbackParams;
    };
} AUDIOCLIENT_ACTIVATION_PARAMS_S;

// ═══════════════════════════════════════════════════════════════════════
// IActivateAudioInterfaceCompletionHandler implementation.
//
// ActivateAudioInterfaceAsync is asynchronous — it calls this handler
// on an MTA thread when activation completes. We use a Win32 event
// to synchronize: main thread waits on the event, handler sets it.
// ═══════════════════════════════════════════════════════════════════════

class CompletionHandler : public IActivateAudioInterfaceCompletionHandler {
    LONG     m_ref;
    HANDLE   m_event;
    HRESULT  m_hrActivate;
    IUnknown* m_pActivated;
    IUnknown* m_ftm;  // Free-Threaded Marshaler — required for MTA callbacks

public:
    CompletionHandler()
        : m_ref(1)
        , m_hrActivate(E_FAIL)
        , m_pActivated(nullptr)
        , m_ftm(nullptr)
    {
        m_event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
        // The Free-Threaded Marshaler tells COM that this object is safe
        // to call from any thread/apartment without proxy. Without it,
        // ActivateAudioInterfaceAsync fails with E_ILLEGAL_METHOD_CALL
        // because COM can't marshal the completion handler to the MTA
        // callback thread.
        CoCreateFreeThreadedMarshaler(
            static_cast<IUnknown*>(
                static_cast<IActivateAudioInterfaceCompletionHandler*>(this)),
            &m_ftm);
    }

    ~CompletionHandler() {
        if (m_ftm) m_ftm->Release();
        if (m_pActivated) m_pActivated->Release();
        if (m_event) CloseHandle(m_event);
    }

    // ─── IUnknown ───
    ULONG STDMETHODCALLTYPE AddRef() override {
        return InterlockedIncrement(&m_ref);
    }

    ULONG STDMETHODCALLTYPE Release() override {
        LONG r = InterlockedDecrement(&m_ref);
        if (r == 0) delete this;
        return r;
    }

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override {
        if (riid == __uuidof(IUnknown) ||
            riid == __uuidof(IActivateAudioInterfaceCompletionHandler)) {
            *ppv = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
            AddRef();
            return S_OK;
        }
        // Delegate IMarshal and IAgileObject to the Free-Threaded Marshaler.
        // This is what Microsoft's FtmBase / RuntimeClass<FtmBase> does.
        if (m_ftm) {
            return m_ftm->QueryInterface(riid, ppv);
        }
        *ppv = nullptr;
        return E_NOINTERFACE;
    }

    // ─── IActivateAudioInterfaceCompletionHandler ───
    // Called by Windows on MTA thread when activation completes.
    HRESULT STDMETHODCALLTYPE ActivateCompleted(
        IActivateAudioInterfaceAsyncOperation* op
    ) override {
        op->GetActivateResult(&m_hrActivate, &m_pActivated);
        SetEvent(m_event);
        return S_OK;
    }

    // Block until activation completes, then extract IAudioClient.
    HRESULT Wait(IAudioClient** ppClient) {
        WaitForSingleObject(m_event, INFINITE);
        fprintf(stderr, "[audio-capture] ActivateResult: hr=0x%08lx pUnk=%p\n",
            m_hrActivate, m_pActivated);
        if (FAILED(m_hrActivate) || !m_pActivated) {
            return FAILED(m_hrActivate) ? m_hrActivate : E_FAIL;
        }
        HRESULT hrQI = m_pActivated->QueryInterface(
            __uuidof(IAudioClient), reinterpret_cast<void**>(ppClient));
        fprintf(stderr, "[audio-capture] QI(IAudioClient): hr=0x%08lx ptr=%p\n",
            hrQI, *ppClient);
        return hrQI;
    }
};

// ═══════════════════════════════════════════════════════════════════════
// Global state
// ═══════════════════════════════════════════════════════════════════════

static volatile BOOL g_running = TRUE;

BOOL WINAPI CtrlHandler(DWORD /* type */) {
    g_running = FALSE;
    return TRUE;
}

// ═══════════════════════════════════════════════════════════════════════
// Binary header written to stdout before PCM data.
// Renderer reads this to configure AudioContext sample rate & channels.
// ═══════════════════════════════════════════════════════════════════════

#pragma pack(push, 1)
struct AudioHeader {
    UINT32 sampleRate;      // e.g. 48000
    UINT16 channels;        // e.g. 2 (stereo)
    UINT16 bitsPerSample;   // e.g. 32 (float32)
    UINT32 formatTag;       // 1 = PCM int, 3 = IEEE float
};
#pragma pack(pop)

// ═══════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════

int wmain(int argc, wchar_t* argv[]) {
    if (argc < 2) {
        fprintf(stderr, "Usage: audio-capture.exe <PID-to-exclude>\n");
        return 1;
    }

    DWORD excludePid = static_cast<DWORD>(_wtoi(argv[1]));
    fprintf(stderr, "[audio-capture] Excluding PID %u from loopback\n", excludePid);

    // Binary mode for stdout — no CR/LF translation
    _setmode(_fileno(stdout), _O_BINARY);

    // Graceful shutdown on Ctrl+C or pipe close
    SetConsoleCtrlHandler(CtrlHandler, TRUE);

    // ─── COM init (MTA required for ActivateAudioInterfaceAsync) ───
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(hr)) {
        fprintf(stderr, "[audio-capture] CoInitializeEx failed: 0x%08lx\n", hr);
        return 1;
    }

    // ─── Setup process-exclusive loopback activation params ───
    AUDIOCLIENT_ACTIVATION_PARAMS_S acParams = {};
    acParams.ActivationType = AC_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    acParams.ProcessLoopbackParams.TargetProcessId = excludePid;
    acParams.ProcessLoopbackParams.ProcessLoopbackMode =
        PL_MODE_EXCLUDE_TARGET_PROCESS_TREE;

    PROPVARIANT activateParams = {};
    activateParams.vt = VT_BLOB;
    activateParams.blob.cbSize = sizeof(acParams);
    activateParams.blob.pBlobData = reinterpret_cast<BYTE*>(&acParams);

    // ─── Activate audio interface asynchronously ───
    auto* handler = new CompletionHandler();
    IActivateAudioInterfaceAsyncOperation* asyncOp = nullptr;

    hr = ActivateAudioInterfaceAsync(
        VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
        __uuidof(IAudioClient),
        &activateParams,
        handler,
        &asyncOp
    );

    if (FAILED(hr)) {
        fprintf(stderr,
            "[audio-capture] ActivateAudioInterfaceAsync failed: 0x%08lx\n"
            "[audio-capture] Process loopback requires Windows 10 21H2+\n", hr);
        handler->Release();
        CoUninitialize();
        return 1;
    }

    // Wait for async activation to complete
    IAudioClient* audioClient = nullptr;
    hr = handler->Wait(&audioClient);
    handler->Release();
    if (asyncOp) asyncOp->Release();

    if (FAILED(hr) || !audioClient) {
        fprintf(stderr, "[audio-capture] Failed to get IAudioClient: 0x%08lx\n", hr);
        CoUninitialize();
        return 1;
    }

    // ─── Get audio format ───
    // Try GetMixFormat first. If it returns E_NOTIMPL (some Windows 11
    // builds do this for process loopback virtual devices), fall back to
    // a standard format: 48000 Hz, stereo, 32-bit float IEEE.
    WAVEFORMATEX* waveFormat = nullptr;
    hr = audioClient->GetMixFormat(&waveFormat);

    // Fallback format: 48kHz stereo float32 — the standard Windows mixer format.
    // WAVEFORMATEXTENSIBLE is required for > 2 channels or non-PCM formats.
    // We use the extensible form with KSDATAFORMAT_SUBTYPE_IEEE_FLOAT.
    WAVEFORMATEXTENSIBLE fallbackFmt = {};
    bool usingFallback = false;

    if (FAILED(hr)) {
        fprintf(stderr, "[audio-capture] GetMixFormat returned 0x%08lx, using fallback 48kHz/stereo/float32\n", hr);

        // KSDATAFORMAT_SUBTYPE_IEEE_FLOAT = {00000003-0000-0010-8000-00AA00389B71}
        static const GUID KSDATAFORMAT_SUBTYPE_IEEE_FLOAT_LOCAL =
            { 0x00000003, 0x0000, 0x0010, { 0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71 } };

        fallbackFmt.Format.wFormatTag      = WAVE_FORMAT_EXTENSIBLE;
        fallbackFmt.Format.nChannels       = 2;
        fallbackFmt.Format.nSamplesPerSec  = 48000;
        fallbackFmt.Format.wBitsPerSample  = 32;
        fallbackFmt.Format.nBlockAlign     = 2 * (32 / 8);  // channels * bytesPerSample
        fallbackFmt.Format.nAvgBytesPerSec = 48000 * fallbackFmt.Format.nBlockAlign;
        fallbackFmt.Format.cbSize          = sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX);
        fallbackFmt.Samples.wValidBitsPerSample = 32;
        fallbackFmt.dwChannelMask          = 3;  // SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT
        fallbackFmt.SubFormat              = KSDATAFORMAT_SUBTYPE_IEEE_FLOAT_LOCAL;

        waveFormat = &fallbackFmt.Format;
        usingFallback = true;
    }

    UINT32 sampleRate    = waveFormat->nSamplesPerSec;
    UINT16 channels      = waveFormat->nChannels;
    UINT16 bitsPerSample = waveFormat->wBitsPerSample;
    UINT32 formatTag     = waveFormat->wFormatTag;

    // WAVEFORMATEXTENSIBLE wraps the actual format tag in SubFormat GUID.
    if (formatTag == WAVE_FORMAT_EXTENSIBLE) {
        auto* ext = reinterpret_cast<WAVEFORMATEXTENSIBLE*>(waveFormat);
        formatTag     = ext->SubFormat.Data1;  // 1=PCM, 3=IEEE_FLOAT
        bitsPerSample = ext->Samples.wValidBitsPerSample;
    }

    UINT32 frameSize = channels * (bitsPerSample / 8);

    fprintf(stderr, "[audio-capture] Format: %u Hz, %u ch, %u bit, tag=%u%s\n",
        sampleRate, channels, bitsPerSample, formatTag,
        usingFallback ? " (fallback)" : "");

    // ─── Initialize audio client ───
    // AUDCLNT_STREAMFLAGS_LOOPBACK: capture from the render endpoint.
    // AUDCLNT_STREAMFLAGS_EVENTCALLBACK: low-latency event-driven capture.
    // AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM: let Windows convert format if needed.
    // Buffer duration 0 = use minimum period (typically ~10ms).
    hr = audioClient->Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK
            | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
        0,      // default buffer duration
        0,      // default periodicity
        waveFormat,
        nullptr
    );
    if (!usingFallback) CoTaskMemFree(waveFormat);

    if (FAILED(hr)) {
        fprintf(stderr, "[audio-capture] Initialize failed: 0x%08lx\n", hr);
        audioClient->Release();
        CoUninitialize();
        return 1;
    }

    // ─── Setup event-driven capture ───
    HANDLE captureEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    hr = audioClient->SetEventHandle(captureEvent);
    if (FAILED(hr)) {
        fprintf(stderr, "[audio-capture] SetEventHandle failed: 0x%08lx\n", hr);
        audioClient->Release();
        CloseHandle(captureEvent);
        CoUninitialize();
        return 1;
    }

    IAudioCaptureClient* captureClient = nullptr;
    hr = audioClient->GetService(
        __uuidof(IAudioCaptureClient),
        reinterpret_cast<void**>(&captureClient)
    );
    if (FAILED(hr)) {
        fprintf(stderr, "[audio-capture] GetService(CaptureClient) failed: 0x%08lx\n", hr);
        audioClient->Release();
        CloseHandle(captureEvent);
        CoUninitialize();
        return 1;
    }

    // ─── Write header to stdout ───
    AudioHeader header;
    header.sampleRate    = sampleRate;
    header.channels      = channels;
    header.bitsPerSample = bitsPerSample;
    header.formatTag     = formatTag;

    if (_write(1, &header, sizeof(header)) != sizeof(header)) {
        fprintf(stderr, "[audio-capture] Failed to write header to stdout\n");
        captureClient->Release();
        audioClient->Release();
        CloseHandle(captureEvent);
        CoUninitialize();
        return 1;
    }

    // ─── Start capture ───
    hr = audioClient->Start();
    if (FAILED(hr)) {
        fprintf(stderr, "[audio-capture] Start failed: 0x%08lx\n", hr);
        captureClient->Release();
        audioClient->Release();
        CloseHandle(captureEvent);
        CoUninitialize();
        return 1;
    }

    fprintf(stderr, "[audio-capture] Capture started (excluding PID %u)\n", excludePid);

    // ─── Capture loop ───
    // Event fires when audio buffer has data. 100ms timeout for checking
    // shutdown flag. On broken pipe (_write returns <= 0), exit cleanly.
    while (g_running) {
        DWORD waitResult = WaitForSingleObject(captureEvent, 100);

        if (waitResult == WAIT_OBJECT_0) {
            // Drain all available packets in this event cycle
            while (true) {
                BYTE*  data      = nullptr;
                UINT32 numFrames = 0;
                DWORD  flags     = 0;

                hr = captureClient->GetBuffer(&data, &numFrames, &flags, nullptr, nullptr);
                if (hr == AUDCLNT_S_BUFFER_EMPTY || FAILED(hr)) break;
                if (numFrames == 0) {
                    captureClient->ReleaseBuffer(numFrames);
                    break;
                }

                UINT32 byteCount = numFrames * frameSize;

                if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
                    // Silent buffer — write zeros instead of garbage data
                    static BYTE zeros[8192];
                    UINT32 remaining = byteCount;
                    while (remaining > 0 && g_running) {
                        UINT32 chunk = remaining > sizeof(zeros) ? sizeof(zeros) : remaining;
                        int w = _write(1, zeros, chunk);
                        if (w <= 0) { g_running = FALSE; break; }
                        remaining -= chunk;
                    }
                } else {
                    // Write actual PCM data
                    int w = _write(1, data, byteCount);
                    if (w <= 0) {
                        // Pipe broken — parent process closed connection
                        g_running = FALSE;
                    }
                }

                captureClient->ReleaseBuffer(numFrames);
            }
        }
        // WAIT_TIMEOUT: just loop back and check g_running
    }

    // ─── Cleanup ───
    fprintf(stderr, "[audio-capture] Stopping capture\n");
    audioClient->Stop();
    captureClient->Release();
    audioClient->Release();
    CloseHandle(captureEvent);
    CoUninitialize();

    return 0;
}
