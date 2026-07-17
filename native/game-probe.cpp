// game-probe.exe - reports which processes are driving the GPU's 3D engine and what window they own.
//
// A sensor, not a policy: it says "pid 1234 at 27% 3D owns hwnd 0x9A, path C:\...\Diablo IV.exe" and
// stops there. Deciding whether that is a game (Steam library, games list, denylist, threshold) lives
// in the renderer where it is testable and translatable.
//
// Reads GPU counters system-wide via PDH, which needs no handle on the game process - anti-cheat has
// nothing to object to. The exe path does open the process, but only PROCESS_QUERY_LIMITED_INFORMATION.
//
// Usage:  game-probe.exe [--interval-ms 2000] [--top 10]
// Emits one JSON line per interval to stdout. Exits when stdin closes.

#include <windows.h>
#include <pdh.h>
#include <pdhmsg.h>
#include <psapi.h>
#include <string>
#include <vector>
#include <map>
#include <algorithm>
#include <cstdio>
#include <cwchar>

#pragma comment(lib, "pdh.lib")
#pragma comment(lib, "user32.lib")

namespace {

struct Candidate {
    DWORD pid = 0;
    double gpu3d = 0.0;
    double videoDecode = 0.0;
    double videoEncode = 0.0;
    HWND hwnd = nullptr;
    long long area = 0;
    std::wstring title;
    std::wstring exePath;
};

// Instance names look like: pid_12345_luid_0x00000000_0x0000C1DB_phys_0_eng_0_engtype_3D
bool ParseInstance(const wchar_t* instance, DWORD& pid, std::wstring& engine) {
    const wchar_t* p = wcsstr(instance, L"pid_");
    if (!p) return false;
    pid = static_cast<DWORD>(_wtoi(p + 4));
    if (pid == 0) return false;

    const wchar_t* e = wcsstr(instance, L"engtype_");
    if (!e) return false;
    engine = e + 8;
    std::transform(engine.begin(), engine.end(), engine.begin(), ::towlower);
    return true;
}

struct WindowSearch {
    DWORD pid;
    HWND best;
    long long bestArea;
};

BOOL CALLBACK PickWindow(HWND hwnd, LPARAM param) {
    auto* s = reinterpret_cast<WindowSearch*>(param);

    DWORD owner = 0;
    GetWindowThreadProcessId(hwnd, &owner);
    if (owner != s->pid) return TRUE;

    // IsIconic matters: a minimised window reports a -32000 rect, which would otherwise win or
    // garbage the area comparison. There is also nothing to capture from one.
    if (!IsWindowVisible(hwnd) || IsIconic(hwnd)) return TRUE;

    RECT r{};
    if (!GetWindowRect(hwnd, &r)) return TRUE;
    long long area = static_cast<long long>(r.right - r.left) * (r.bottom - r.top);
    if (area <= 0) return TRUE;

    // Largest visible top-level window - games own splash and message-only windows too.
    if (area > s->bestArea) {
        s->bestArea = area;
        s->best = hwnd;
    }
    return TRUE;
}

void FillWindow(Candidate& c) {
    WindowSearch s{c.pid, nullptr, 0};
    EnumWindows(PickWindow, reinterpret_cast<LPARAM>(&s));
    c.hwnd = s.best;
    c.area = s.bestArea;
    if (!c.hwnd) return;

    wchar_t buf[512] = {};
    GetWindowTextW(c.hwnd, buf, 512);
    c.title = buf;
}

// Empty when the process is out of reach: SYSTEM/other-user, or elevated while we are not. The
// caller falls back to the window title for a name.
std::wstring ExePath(DWORD pid) {
    HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!h) return L"";
    wchar_t buf[MAX_PATH * 2] = {};
    DWORD len = MAX_PATH * 2;
    std::wstring out;
    if (QueryFullProcessImageNameW(h, 0, buf, &len)) out.assign(buf, len);
    CloseHandle(h);
    return out;
}

void JsonEscape(const std::wstring& in, std::wstring& out) {
    for (wchar_t ch : in) {
        switch (ch) {
            case L'"':  out += L"\\\""; break;
            case L'\\': out += L"\\\\"; break;
            case L'\n': out += L"\\n";  break;
            case L'\r': out += L"\\r";  break;
            case L'\t': out += L"\\t";  break;
            default:
                if (ch < 0x20) {
                    wchar_t esc[8];
                    swprintf_s(esc, L"\\u%04x", ch);
                    out += esc;
                } else {
                    out += ch;
                }
        }
    }
}

// Exits the poll loop when the parent closes our stdin - the same shutdown contract the game-capture
// helper uses, because kill() on Windows is TerminateProcess and runs no cleanup.
DWORD WINAPI WatchStdin(LPVOID param) {
    auto* running = static_cast<volatile bool*>(param);
    char sink[256];
    DWORD read = 0;
    HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
    while (ReadFile(in, sink, sizeof(sink), &read, nullptr) && read > 0) {
    }
    *running = false;
    return 0;
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
    DWORD intervalMs = 2000;
    size_t top = 10;

    for (int i = 1; i < argc; i++) {
        if (!wcscmp(argv[i], L"--interval-ms") && i + 1 < argc) intervalMs = _wtoi(argv[++i]);
        else if (!wcscmp(argv[i], L"--top") && i + 1 < argc) top = static_cast<size_t>(_wtoi(argv[++i]));
    }

    PDH_HQUERY query = nullptr;
    if (PdhOpenQueryW(nullptr, 0, &query) != ERROR_SUCCESS) {
        fwprintf(stderr, L"game-probe: PdhOpenQuery failed\n");
        return 1;
    }

    // English, not localised: PDH counter paths are translated on non-English Windows, and
    // "\GPU Engine(*)\Utilization Percentage" would simply not resolve there.
    PDH_HCOUNTER counter = nullptr;
    PDH_STATUS st = PdhAddEnglishCounterW(query, L"\\GPU Engine(*)\\Utilization Percentage", 0, &counter);
    if (st != ERROR_SUCCESS) {
        // No GPU Engine counters: pre-WDDM2 driver, or a machine with no GPU worth polling.
        fwprintf(stderr, L"game-probe: no GPU Engine counters (0x%08lx)\n", static_cast<unsigned long>(st));
        PdhCloseQuery(query);
        return 2;
    }

    volatile bool running = true;
    CreateThread(nullptr, 0, WatchStdin, const_cast<bool*>(&running), 0, nullptr);

    // Utilization Percentage needs two samples to produce a value; the first collect only primes it.
    PdhCollectQueryData(query);

    while (running) {
        Sleep(intervalMs);
        if (!running) break;
        if (PdhCollectQueryData(query) != ERROR_SUCCESS) continue;

        DWORD bufSize = 0, itemCount = 0;
        st = PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, &bufSize, &itemCount, nullptr);
        if (st != PDH_MORE_DATA || bufSize == 0) continue;

        std::vector<BYTE> buf(bufSize);
        auto* items = reinterpret_cast<PDH_FMT_COUNTERVALUE_ITEM_W*>(buf.data());
        if (PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, &bufSize, &itemCount, items) != ERROR_SUCCESS) {
            continue;
        }

        // A pid appears once per engine instance and once per GPU - a laptop with two GPUs reports
        // separate LUIDs. Sum them so a pid has one number per engine.
        std::map<DWORD, Candidate> byPid;
        for (DWORD i = 0; i < itemCount; i++) {
            if (items[i].FmtValue.CStatus != ERROR_SUCCESS) continue;
            double v = items[i].FmtValue.doubleValue;
            if (v <= 0.0) continue;

            DWORD pid = 0;
            std::wstring engine;
            if (!ParseInstance(items[i].szName, pid, engine)) continue;

            Candidate& c = byPid[pid];
            c.pid = pid;
            if (engine == L"3d") c.gpu3d += v;
            else if (engine == L"videodecode") c.videoDecode += v;
            else if (engine == L"videoencode") c.videoEncode += v;
        }

        std::vector<Candidate> ranked;
        ranked.reserve(byPid.size());
        for (auto& kv : byPid) ranked.push_back(kv.second);
        std::sort(ranked.begin(), ranked.end(),
                  [](const Candidate& a, const Candidate& b) { return a.gpu3d > b.gpu3d; });
        if (ranked.size() > top) ranked.resize(top);

        // Only the shortlist pays for OpenProcess and an EnumWindows sweep.
        for (Candidate& c : ranked) {
            FillWindow(c);
            c.exePath = ExePath(c.pid);
        }

        std::wstring line = L"{\"candidates\":[";
        bool first = true;
        for (const Candidate& c : ranked) {
            if (!first) line += L",";
            first = false;

            std::wstring title, path;
            JsonEscape(c.title, title);
            JsonEscape(c.exePath, path);

            wchar_t head[256];
            swprintf_s(head,
                       L"{\"pid\":%lu,\"gpu3d\":%.1f,\"videoDecode\":%.1f,\"videoEncode\":%.1f,"
                       L"\"hwnd\":%lld,\"area\":%lld,",
                       c.pid, c.gpu3d, c.videoDecode, c.videoEncode,
                       reinterpret_cast<long long>(c.hwnd), c.area);
            line += head;
            line += L"\"title\":\"" + title + L"\",";
            line += L"\"exePath\":\"" + path + L"\"}";
        }
        line += L"]}\n";

        fputws(line.c_str(), stdout);
        fflush(stdout);
    }

    PdhCloseQuery(query);
    return 0;
}
