/**
 * GameShareRow — offers the game you are playing, one click, no picker.
 *
 * Renders nothing unless a game is actually detected, so on macOS, Linux, in the browser, or with
 * nothing running, the voice panel looks exactly as it did.
 */

import { useTranslation } from "react-i18next";
import { useGameDetection } from "../../hooks/useGameDetection";

type GameShareRowProps = {
  isInVoice: boolean;
  /** Hidden while a share is up — there is only one to give. */
  isSharing: boolean;
  /** The normal share path, used when the native engine can't take it. */
  onFallbackShare: () => void;
};

function GameShareRow({ isInVoice, isSharing, onFallbackShare }: GameShareRowProps) {
  const { t } = useTranslation("voice");
  const { game, isStarting, shareGame } = useGameDetection(isInVoice);

  if (!game || isSharing) return null;

  return (
    <div className="ub-game-row">
      {game.icon ? (
        <img className="ub-game-icon" src={game.icon} alt="" />
      ) : (
        <div className="ub-game-icon ub-game-icon-fallback" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M21 6H3a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2zM8 13H6v2H4v-2H2v-2h2V9h2v2h2v2zm7.5 2a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm3-3a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z" />
          </svg>
        </div>
      )}

      <div className="ub-game-text">
        <span className="ub-game-label">{t("playingNow")}</span>
        <span className="ub-game-name" title={game.name}>
          {game.name}
        </span>
      </div>

      <button
        className="ub-game-btn"
        onClick={() => void shareGame(onFallbackShare)}
        disabled={isStarting}
        title={t("shareGame", { game: game.name })}
      >
        {isStarting ? t("starting") : t("goLive")}
      </button>
    </div>
  );
}

export default GameShareRow;
