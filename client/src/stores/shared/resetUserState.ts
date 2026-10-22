/**
 * Everything held in memory for the signed-in account, dropped at sign-out. The app does not
 * reload between one account signing out and the next signing in, so whatever stays here is shown
 * to the next account — A's open tabs came back for B on a shared device.
 *
 * Device preferences (soundboard volume, voice settings, sidebar sections, app settings) are not
 * account data and stay. Stores with their own teardown (auth, E2EE, preferences, guide, session,
 * calls, voice, outbox) are reset by the sign-out itself.
 */

import { useUIStore } from "../uiStore";
import { useMessageStore } from "../messageStore";
import { useDMStore } from "../dmStore";
import { useServerStore, forgetLastServer } from "../serverStore";
import { useChannelStore } from "../channelStore";
import { useReadStateStore } from "../readStateStore";
import { useMemberStore } from "../memberStore";
import { useRoleStore } from "../roleStore";
import { useChannelPermissionStore } from "../channelPermissionStore";
import { usePinStore } from "../pinStore";
import { useFriendStore } from "../friendStore";
import { useBlockStore } from "../blockStore";
import { useBadgeStore } from "../badgeStore";
import { useInviteStore } from "../inviteStore";
import { useJoinRequestStore } from "../joinRequestStore";
import { useVoiceMessageStore } from "../voiceMessageStore";
import { useSoundboardStore } from "../soundboardStore";
import { useSettingsBadgeStore } from "../settingsBadgeStore";
import { useSpotlightStore } from "../spotlightStore";
import { useFileViewerStore } from "../fileViewerStore";
import { useMobileStore } from "../mobileStore";
import { resetDMDeliveryReports } from "./dmDeliveryReports";
import { abortSessionRequests } from "../../api/client";

type Resettable = { getInitialState: () => object; setState: (state: never, replace: true) => void };

function toInitial(store: Resettable): void {
  store.setState(store.getInitialState() as never, true);
}

export function resetUserState(): void {
  // First: a request this account started must not answer into the stores after they are reset.
  abortSessionRequests();

  // Their module-level "already fetched" and "unverified" sets go first, or a fetch for the next
  // account would think its conversations are already loaded.
  useMessageStore.getState().invalidateFetchCache();
  useDMStore.getState().invalidateFetchCache();

  for (const store of [
    useUIStore, useMessageStore, useDMStore, useChannelStore, useReadStateStore, useMemberStore,
    useRoleStore, useChannelPermissionStore, usePinStore, useFriendStore, useBlockStore,
    useBadgeStore, useInviteStore, useJoinRequestStore, useVoiceMessageStore,
    useSettingsBadgeStore, useSpotlightStore, useFileViewerStore, useMobileStore,
  ] as Resettable[]) {
    toInitial(store);
  }

  resetDMDeliveryReports();

  // The initial state read the last server from storage at startup: this account's, by now.
  forgetLastServer();
  useServerStore.setState({ ...useServerStore.getInitialState(), activeServerId: null }, true);

  const { volume, muted } = useSoundboardStore.getState();
  useSoundboardStore.setState({ ...useSoundboardStore.getInitialState(), volume, muted }, true);
}
