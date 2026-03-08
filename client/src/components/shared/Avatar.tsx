/** Avatar — Role-based gradient avatar with image or initial fallback. */

import { resolveAssetUrl } from "../../utils/constants";

type AvatarProps = {
  name: string;
  role?: "admin" | "mod" | null;
  avatarUrl?: string | null;
  size?: number;
  isCircle?: boolean;
};

function getGradientClass(role?: "admin" | "mod" | null): string {
  switch (role) {
    case "admin":
      return "av-admin";
    case "mod":
      return "av-mod";
    default:
      return "av-default";
  }
}

function Avatar({ name, role, avatarUrl, size = 30, isCircle = true }: AvatarProps) {
  const roundClass = isCircle ? "avatar avatar-round" : "avatar";
  const fontSize = size * 0.37;

  if (avatarUrl) {
    return (
      <img
        src={resolveAssetUrl(avatarUrl)}
        alt={name}
        className={roundClass}
        style={{ width: size, height: size, objectFit: "cover" }}
      />
    );
  }

  return (
    <div
      className={`${roundClass} ${getGradientClass(role)}`}
      style={{ width: size, height: size, fontSize }}
    >
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

export default Avatar;
