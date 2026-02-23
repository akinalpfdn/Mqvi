/**
 * p2pCallStore — P2P (peer-to-peer) arama state yönetimi.
 *
 * Zustand store — voiceStore ile benzer pattern.
 *
 * Sorumluluklar:
 * 1. activeCall: Aktif veya çalma durumundaki arama
 * 2. incomingCall: Gelen arama bildirimi (henüz kabul/red edilmemiş)
 * 3. localStream / remoteStream: WebRTC medya stream'leri
 * 4. peerConnection: RTCPeerConnection instance'ı
 * 5. isMuted / isVideoOn / isScreenSharing: Lokal kontrol state'leri
 * 6. callDuration: Aktif arama süresi (saniye)
 * 7. WS event handler'ları (p2p_call_initiate, accept, decline, end, busy, signal)
 *
 * WebRTC P2P akışı:
 * - Medya doğrudan kullanıcılar arasında akar (server relay yok)
 * - Server sadece signaling (SDP/ICE exchange) için kullanılır
 * - STUN sunucusu ile NAT arkasındaki cihazlar birbirini bulur
 *
 * Arama akışı:
 * 1. Caller: initiateCall → server validate → receiver'a broadcast
 * 2. Receiver: acceptCall → WebRTC negotiation başlar
 * 3. Caller: createOffer → relay → Receiver: createAnswer → relay
 * 4. ICE candidates karşılıklı relay edilir
 * 5. Medya P2P akmaya başlar
 */

import { create } from "zustand";
import type { P2PCall, P2PCallType, P2PSignalPayload } from "../types";

// ─── STUN Configuration ───

/**
 * ICE server yapılandırması.
 * STUN sunucusu NAT arkasındaki cihazların public IP'sini öğrenmesi için gereklidir.
 * Google'ın ücretsiz STUN sunucuları kullanılır — TURN (relay) olmadan sadece P2P bağlantı.
 *
 * STUN nedir?
 * Session Traversal Utilities for NAT — NAT arkasındaki cihazın public IP:port bilgisini
 * öğrenmek için kullanılan protokol. STUN sunucusu "senin dış IP'n şu, portun bu" der.
 * Bu bilgi ICE candidate olarak karşı tarafa gönderilir.
 */
const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

// ─── Types ───

type P2PCallStore = {
  /** Aktif arama (ringing veya active durumda) — null ise aramada değiliz */
  activeCall: P2PCall | null;

  /** Gelen arama bildirimi — IncomingCallOverlay tarafından kullanılır */
  incomingCall: P2PCall | null;

  /** Kendi medya stream'imiz (mikrofon + opsiyonel kamera) */
  localStream: MediaStream | null;

  /** Karşı tarafın medya stream'i (WebRTC ontrack ile alınır) */
  remoteStream: MediaStream | null;

  /** WebRTC peer connection instance'ı */
  peerConnection: RTCPeerConnection | null;

  /**
   * ICE candidate kuyruğu — remote description henüz set edilmemişken
   * gelen ICE candidate'lar burada biriktirilir.
   *
   * Neden gerekli?
   * WebRTC'de ICE candidate'lar ve SDP offer/answer WS üzerinden ayrı ayrı gönderilir.
   * Ağ gecikmesi nedeniyle ICE candidate'lar, SDP offer/answer'dan ÖNCE gelebilir.
   * Ancak addIceCandidate() çağrılabilmesi için remoteDescription'ın set edilmiş olması gerekir.
   * Bu kuyruk, erken gelen candidate'ları biriktirir ve setRemoteDescription sonrası flush eder.
   */
  _pendingCandidates: RTCIceCandidateInit[];

  /** Mikrofon kapalı mı? */
  isMuted: boolean;

  /** Kamera açık mı? (sadece video call'da anlamlı) */
  isVideoOn: boolean;

  /** Ekran paylaşımı aktif mi? */
  isScreenSharing: boolean;

  /** Aktif arama süresi (saniye) — timer ile artırılır */
  callDuration: number;

  /** Call duration interval ID'si */
  _durationInterval: ReturnType<typeof setInterval> | null;

  // ─── WS Send Fonksiyonu ───

  /**
   * _sendWS — WebSocket üzerinden event göndermek için callback.
   * useWebSocket hook'unda register edilir (DI pattern).
   *
   * Neden store'da tutuluyor?
   * Store, React component'lerden bağımsız çalışır (getState ile erişim).
   * WS send fonksiyonunu store'a inject ederek, hem component'ler hem de
   * store action'ları WS mesajı gönderebilir.
   */
  _sendWS: ((op: string, data?: unknown) => void) | null;
  registerSendWS: (fn: ((op: string, data?: unknown) => void) | null) => void;

  // ─── Actions ───

  /** Arama başlat — caller tarafında çağrılır */
  initiateCall: (receiverId: string, callType: P2PCallType) => void;

  /** Gelen aramayı kabul et — receiver tarafında çağrılır */
  acceptCall: (callId: string) => void;

  /** Gelen aramayı reddet veya başlatılan aramayı iptal et */
  declineCall: (callId: string) => void;

  /** Aktif aramayı sonlandır */
  endCall: () => void;

  /** Mikrofon toggle */
  toggleMute: () => void;

  /** Kamera toggle (video call'da) */
  toggleVideo: () => void;

  /** Ekran paylaşımı toggle */
  toggleScreenShare: () => void;

  /**
   * WebRTC bağlantısını başlat — caller tarafında acceptCall geldiğinde çağrılır.
   * RTCPeerConnection oluşturur, offer yaratır ve relay eder.
   */
  startWebRTC: (isCaller: boolean) => Promise<void>;

  /** Tüm state'i sıfırla — arama bittiğinde çağrılır */
  cleanup: () => void;

  // ─── WS Event Handlers ───

  /** p2p_call_initiate event'i geldiğinde (hem caller hem receiver alır) */
  handleCallInitiate: (data: P2PCall) => void;

  /** p2p_call_accept event'i geldiğinde */
  handleCallAccept: (data: { call_id: string }) => void;

  /** p2p_call_decline event'i geldiğinde */
  handleCallDecline: (data: { call_id: string }) => void;

  /** p2p_call_end event'i geldiğinde */
  handleCallEnd: (data: { call_id: string; reason?: string }) => void;

  /** p2p_call_busy event'i geldiğinde (karşı taraf başka aramada) */
  handleCallBusy: (data: { receiver_id: string }) => void;

  /** p2p_signal event'i geldiğinde (SDP/ICE relay) */
  handleSignal: (data: P2PSignalPayload) => void;
};

// ─── Helper: getUserMedia ───

/**
 * getMediaStream — Kullanıcıdan medya izni alır ve stream döner.
 *
 * getUserMedia nedir?
 * Tarayıcıdan mikrofon ve/veya kamera erişimi isteyen Web API.
 * Kullanıcı izin verirse MediaStream döner — bu stream WebRTC'ye eklenir.
 *
 * @param callType "voice" → sadece mikrofon, "video" → mikrofon + kamera
 */
async function getMediaStream(callType: P2PCallType): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: true,
    video: callType === "video",
  });
}

// ─── Store ───

export const useP2PCallStore = create<P2PCallStore>((set, get) => ({
  activeCall: null,
  incomingCall: null,
  localStream: null,
  remoteStream: null,
  peerConnection: null,
  isMuted: false,
  isVideoOn: false,
  isScreenSharing: false,
  callDuration: 0,
  _durationInterval: null,
  _pendingCandidates: [],
  _sendWS: null,

  registerSendWS: (fn) => set({ _sendWS: fn }),

  // ─── Actions ───

  initiateCall: (receiverId, callType) => {
    const { _sendWS } = get();
    if (!_sendWS) return;

    _sendWS("p2p_call_initiate", {
      receiver_id: receiverId,
      call_type: callType,
    });
  },

  acceptCall: (callId) => {
    const { _sendWS, incomingCall } = get();
    if (!_sendWS || !incomingCall) return;

    _sendWS("p2p_call_accept", { call_id: callId });
  },

  declineCall: (callId) => {
    const { _sendWS } = get();
    if (!_sendWS) return;

    _sendWS("p2p_call_decline", { call_id: callId });

    // Lokal state temizle
    set({ incomingCall: null, activeCall: null });
  },

  endCall: () => {
    const { _sendWS } = get();
    if (!_sendWS) return;

    _sendWS("p2p_call_end");
    get().cleanup();
  },

  toggleMute: () => {
    const { localStream, isMuted } = get();
    if (localStream) {
      // Audio track'lerin enabled durumunu toggle et.
      // enabled=false → mikrofon susturulur ama track hâlâ aktif (bağlantı kopmaz).
      for (const track of localStream.getAudioTracks()) {
        track.enabled = isMuted; // isMuted ise açıyoruz (toggle)
      }
    }
    set({ isMuted: !isMuted });
  },

  toggleVideo: () => {
    const { localStream, isVideoOn, peerConnection, activeCall, _sendWS } = get();
    if (!localStream || !peerConnection || !activeCall) return;

    if (isVideoOn) {
      // Video kapatılıyor — track'leri disable et
      for (const track of localStream.getVideoTracks()) {
        track.enabled = false;
      }
      set({ isVideoOn: false });
    } else {
      // Video açılıyor — mevcut video track varsa enable et, yoksa yeni al
      const existingVideoTrack = localStream.getVideoTracks()[0];
      if (existingVideoTrack) {
        existingVideoTrack.enabled = true;
        set({ isVideoOn: true });
      } else {
        // Yeni video track al ve PeerConnection'a ekle
        navigator.mediaDevices
          .getUserMedia({ video: true })
          .then((videoStream) => {
            const videoTrack = videoStream.getVideoTracks()[0];
            localStream.addTrack(videoTrack);

            // PeerConnection'a video track ekle
            peerConnection.addTrack(videoTrack, localStream);

            // Renegotiation gerekli — yeni offer oluştur
            peerConnection
              .createOffer()
              .then((offer) => peerConnection.setLocalDescription(offer))
              .then(() => {
                if (_sendWS && peerConnection.localDescription) {
                  _sendWS("p2p_signal", {
                    call_id: activeCall.id,
                    type: "offer",
                    sdp: peerConnection.localDescription.sdp,
                  });
                }
              });

            set({ isVideoOn: true });
          })
          .catch((err) => {
            console.error("[p2p] Failed to get video:", err);
          });
      }
    }
  },

  toggleScreenShare: () => {
    const { isScreenSharing, peerConnection, localStream, activeCall } = get();
    if (!peerConnection || !activeCall) return;

    if (isScreenSharing) {
      // Ekran paylaşımını durdur — screen track'i kamera ile değiştir veya kaldır
      const senders = peerConnection.getSenders();
      const videoSender = senders.find((s) => s.track?.kind === "video");

      if (videoSender && localStream) {
        const cameraTrack = localStream.getVideoTracks()[0];
        if (cameraTrack) {
          // replaceTrack — mevcut video sender'ın track'ini değiştirir.
          // Renegotiation gerektirmez (aynı medya türü için).
          videoSender.replaceTrack(cameraTrack);
        } else {
          videoSender.replaceTrack(null);
        }
      }
      set({ isScreenSharing: false });
    } else {
      // Ekran paylaşımını başlat
      // getDisplayMedia — tarayıcıdan ekran/pencere/sekme seçimi ister.
      navigator.mediaDevices
        .getDisplayMedia({ video: true })
        .then((screenStream) => {
          const screenTrack = screenStream.getVideoTracks()[0];

          // PeerConnection'daki video track'i ekran track'i ile değiştir
          const senders = peerConnection.getSenders();
          const videoSender = senders.find((s) => s.track?.kind === "video");

          if (videoSender) {
            videoSender.replaceTrack(screenTrack);
          } else {
            peerConnection.addTrack(screenTrack, screenStream);
          }

          // Kullanıcı "paylaşımı durdur" butonuna tıklarsa (tarayıcı native UI)
          // track.onended otomatik tetiklenir — state'i sıfırla.
          screenTrack.onended = () => {
            if (videoSender && localStream) {
              const cam = localStream.getVideoTracks()[0];
              videoSender.replaceTrack(cam ?? null);
            }
            set({ isScreenSharing: false });
          };

          set({ isScreenSharing: true });
        })
        .catch((err) => {
          // Kullanıcı paylaşımı iptal ettiyse hata fırlatılır — sessizce devam et
          console.error("[p2p] Screen share error:", err);
        });
    }
  },

  startWebRTC: async (isCaller) => {
    const { activeCall, _sendWS } = get();
    if (!activeCall || !_sendWS) return;

    try {
      // 1. Medya izni al
      const stream = await getMediaStream(activeCall.call_type);
      set({
        localStream: stream,
        isVideoOn: activeCall.call_type === "video",
      });

      // 2. RTCPeerConnection oluştur
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

      // 3. onicecandidate — Yeni ICE candidate bulunduğunda WS üzerinden relay et
      //
      // ICE candidate nedir?
      // Cihazın ağ üzerinden erişilebilir olduğu adres bilgisi (IP:port).
      // STUN sunucusu ile public adresi öğrenilir, bu candidate karşı tarafa gönderilir.
      // Her iki taraf da birbirinin candidate'larını deneyerek bağlantı kurar.
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          _sendWS("p2p_signal", {
            call_id: activeCall.id,
            type: "ice-candidate",
            candidate: event.candidate.toJSON(),
          });
        }
      };

      // 4. ontrack — Karşı taraftan medya geldiğinde remote stream'e ekle
      //
      // ontrack nedir?
      // RTCPeerConnection karşı taraftan medya track (ses/video) aldığında tetiklenir.
      // event.streams[0] karşı tarafın MediaStream'idir — <video> elementine bağlanır.
      pc.ontrack = (event) => {
        set({ remoteStream: event.streams[0] ?? null });
      };

      // 5. onconnectionstatechange — Bağlantı durumu takibi
      pc.onconnectionstatechange = () => {
        if (
          pc.connectionState === "disconnected" ||
          pc.connectionState === "failed" ||
          pc.connectionState === "closed"
        ) {
          console.warn("[p2p] PeerConnection state:", pc.connectionState);
          // Bağlantı koptu — arama sonlandır
          const current = get();
          if (current.activeCall) {
            current.endCall();
          }
        }
      };

      // 6. Lokal track'leri PeerConnection'a ekle
      for (const track of stream.getTracks()) {
        pc.addTrack(track, stream);
      }

      set({ peerConnection: pc });

      // 7. Caller ise → SDP offer oluştur ve relay et
      //
      // SDP Offer/Answer modeli:
      // - Caller "offer" oluşturur (hangi codec'leri, formatları desteklediğini bildirir)
      // - Receiver "answer" oluşturur (desteklediği codec'leri bildirir)
      // - İki taraf ortak codec'te anlaşır → medya akmaya başlar
      if (isCaller) {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        _sendWS("p2p_signal", {
          call_id: activeCall.id,
          type: "offer",
          sdp: offer.sdp,
        });
      }
    } catch (err) {
      console.error("[p2p] WebRTC start error:", err);
      get().cleanup();
    }
  },

  cleanup: () => {
    const { localStream, peerConnection, _durationInterval } = get();

    // Tüm medya track'lerini durdur
    if (localStream) {
      for (const track of localStream.getTracks()) {
        track.stop();
      }
    }

    // PeerConnection'ı kapat
    if (peerConnection) {
      peerConnection.close();
    }

    // Duration timer'ı temizle
    if (_durationInterval) {
      clearInterval(_durationInterval);
    }

    set({
      activeCall: null,
      incomingCall: null,
      localStream: null,
      remoteStream: null,
      peerConnection: null,
      isMuted: false,
      isVideoOn: false,
      isScreenSharing: false,
      callDuration: 0,
      _durationInterval: null,
      _pendingCandidates: [],
    });
  },

  // ─── WS Event Handlers ───

  handleCallInitiate: (data) => {
    const { activeCall } = get();

    // Zaten bir aramadaysak bu gelen aramadır → incomingCall'a ata
    // Yoksa biz başlatıyorsak → activeCall'a ata
    if (activeCall) {
      // Zaten aktif aramadaysak, sadece gelen arama overlay göster
      set({ incomingCall: data });
    } else {
      // Bu event hem caller'a hem receiver'a gelir.
      // Caller kendi başlattığı aramayı activeCall olarak set eder.
      // Receiver ise incomingCall olarak set eder.
      // Ayrım: Eğer callerID bizim user ID'miz ise biz caller'ız.
      // Bu kontrol component seviyesinde yapılır (useAuthStore.user.id ile).
      // Burada her iki durumda da data'yı tutarız, component karar verir.
      //
      // Aslında ikisini de set edelim — component kendi rolüne göre render eder.
      // Ancak daha temizi: caller ise activeCall, receiver ise incomingCall.
      // Bu ayrımı dışarıdan yapmak gerekir — şimdilik her iki field'ı kontrol eden
      // component seviyesinde yapılır.
      set({ activeCall: data, incomingCall: data });
    }
  },

  handleCallAccept: (data) => {
    const { activeCall } = get();
    if (!activeCall || activeCall.id !== data.call_id) return;

    // Arama kabul edildi — status güncelle, incomingCall temizle
    set({
      activeCall: { ...activeCall, status: "active" },
      incomingCall: null,
    });

    // Duration timer başlat (her saniye artır)
    const interval = setInterval(() => {
      set((state) => ({ callDuration: state.callDuration + 1 }));
    }, 1000);
    set({ _durationInterval: interval });

    // WebRTC negotiation — caller isCaller=true, receiver isCaller=false.
    // handleCallAccept HER İKİ tarafta da tetiklenir.
    // Caller: Bu event'i alınca offer oluşturmalı → startWebRTC(true).
    // Receiver: Bu event'i alınca stream hazırlamalı, offer beklemeli → startWebRTC(false).
    //
    // Hangimiz caller? activeCall.caller_id === bizim userId ise biz caller'ız.
    // userId bilgisi store'da yok — bu kararı component verecek ve startWebRTC çağıracak.
    // Store sadece state günceller.
  },

  handleCallDecline: (data) => {
    const { activeCall, incomingCall } = get();

    // Aktif arama reddedildi
    if (activeCall && activeCall.id === data.call_id) {
      get().cleanup();
      return;
    }

    // Gelen arama reddedildi (caller iptal etti)
    if (incomingCall && incomingCall.id === data.call_id) {
      set({ incomingCall: null });
    }
  },

  handleCallEnd: () => {
    get().cleanup();
  },

  handleCallBusy: () => {
    // Karşı taraf meşgul — arama state'ini temizle
    get().cleanup();
  },

  handleSignal: async (data) => {
    const { peerConnection, activeCall, _sendWS, localStream } = get();

    switch (data.type) {
      case "offer": {
        // SDP offer geldi (biz receiver'ız)
        // PeerConnection yoksa oluştur
        let pc = peerConnection;
        if (!pc) {
          pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

          pc.onicecandidate = (event) => {
            if (event.candidate && _sendWS && activeCall) {
              _sendWS("p2p_signal", {
                call_id: activeCall.id,
                type: "ice-candidate",
                candidate: event.candidate.toJSON(),
              });
            }
          };

          pc.ontrack = (event) => {
            set({ remoteStream: event.streams[0] ?? null });
          };

          pc.onconnectionstatechange = () => {
            if (
              pc!.connectionState === "disconnected" ||
              pc!.connectionState === "failed" ||
              pc!.connectionState === "closed"
            ) {
              const current = get();
              if (current.activeCall) {
                current.endCall();
              }
            }
          };

          // Lokal stream'i ekle
          if (localStream) {
            for (const track of localStream.getTracks()) {
              pc.addTrack(track, localStream);
            }
          }

          set({ peerConnection: pc });
        }

        // Remote description set et (offer)
        await pc.setRemoteDescription(
          new RTCSessionDescription({ type: "offer", sdp: data.sdp })
        );

        // Kuyruklanmış ICE candidate'ları flush et
        // setRemoteDescription başarılı → artık addIceCandidate çağrılabilir.
        const pendingOffer = get()._pendingCandidates;
        if (pendingOffer.length > 0) {
          set({ _pendingCandidates: [] });
          for (const c of pendingOffer) {
            await pc.addIceCandidate(new RTCIceCandidate(c));
          }
        }

        // Answer oluştur ve relay et
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        if (_sendWS && activeCall) {
          _sendWS("p2p_signal", {
            call_id: activeCall.id,
            type: "answer",
            sdp: answer.sdp,
          });
        }
        break;
      }

      case "answer": {
        // SDP answer geldi (biz caller'ız)
        if (!peerConnection) return;
        await peerConnection.setRemoteDescription(
          new RTCSessionDescription({ type: "answer", sdp: data.sdp })
        );

        // Kuyruklanmış ICE candidate'ları flush et
        const pendingAnswer = get()._pendingCandidates;
        if (pendingAnswer.length > 0) {
          set({ _pendingCandidates: [] });
          for (const c of pendingAnswer) {
            await peerConnection.addIceCandidate(new RTCIceCandidate(c));
          }
        }
        break;
      }

      case "ice-candidate": {
        // ICE candidate geldi — remote description set edilmişse ekle, yoksa kuyruğa al.
        //
        // Race condition koruması:
        // ICE candidate'lar WS üzerinden SDP offer/answer'dan önce gelebilir.
        // addIceCandidate() çağrısı remoteDescription null iken InvalidStateError fırlatır.
        // Bu yüzden candidate'ları biriktirip setRemoteDescription sonrası flush ediyoruz.
        if (!data.candidate) break;

        const candidateInit = data.candidate as RTCIceCandidateInit;

        // PeerConnection henüz oluşturulmamış veya remoteDescription henüz set edilmemişse → kuyrukla
        if (!peerConnection || !peerConnection.remoteDescription) {
          set((state) => ({
            _pendingCandidates: [...state._pendingCandidates, candidateInit],
          }));
        } else {
          await peerConnection.addIceCandidate(new RTCIceCandidate(candidateInit));
        }
        break;
      }
    }
  },
}));
