import { useTranslation } from "react-i18next";
import { resolveAssetUrl } from "../../utils/constants";
import Avatar from "../shared/Avatar";
import { VerifiedBadge, FeaturedBadge } from "./DiscoveryBadges";
import type { PublicServerListItem } from "../../api/discovery";

export type JoinStatus = "idle" | "joining" | "pending";

type Props = {
  item: PublicServerListItem;
  status: JoinStatus;
  onJoin: (item: PublicServerListItem) => void;
  onReport: (item: PublicServerListItem) => void;
};

function DiscoveryServerCard({ item, status, onJoin, onReport }: Props) {
  const { t } = useTranslation("discovery");

  const label = item.is_member
    ? t("joined")
    : status === "pending"
      ? t("requested")
      : status === "joining"
        ? t("joining")
        : item.approval_required
          ? t("requestToJoin")
          : t("join");

  const disabled = item.is_member || status !== "idle";

  return (
    <div className="disc-card">
      <div className="disc-card-banner">
        {item.banner_url ? (
          <img src={resolveAssetUrl(item.banner_url)} alt="" className="disc-card-banner-img" />
        ) : (
          <div className="disc-card-banner-fallback" />
        )}
      </div>

      <div className="disc-card-body">
        <div className="disc-card-icon">
          {item.icon_url ? (
            <img src={resolveAssetUrl(item.icon_url)} alt={item.name} className="disc-card-icon-img" />
          ) : (
            <Avatar name={item.name} size={48} isCircle={false} />
          )}
        </div>

        <div className="disc-card-head">
          <span className="disc-card-name">{item.name}</span>
          {item.verified && <VerifiedBadge title={t("verified")} />}
          {item.featured && <FeaturedBadge title={t("featuredBadge")} />}
          <button
            className="disc-card-report"
            title={t("report")}
            onClick={() => onReport(item)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
              <line x1="4" y1="22" x2="4" y2="15" />
            </svg>
          </button>
        </div>

        <p className="disc-card-desc">{item.description || t("noDescription")}</p>

        <div className="disc-card-footer">
          <span className="disc-card-stat">
            <span className="disc-dot disc-dot-online" />
            {t("onlineCount", { count: item.online_count })}
          </span>
          <span className="disc-card-stat">
            <span className="disc-dot" />
            {t("memberCount", { count: item.member_count })}
          </span>
        </div>

        <button className="disc-card-join" disabled={disabled} onClick={() => onJoin(item)}>
          {label}
        </button>
      </div>
    </div>
  );
}

export default DiscoveryServerCard;
