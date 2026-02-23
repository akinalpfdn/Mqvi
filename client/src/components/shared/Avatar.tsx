/**
 * Avatar — Yeniden kullanılabilir role-based gradient avatar.
 *
 * CSS class'ları: .avatar, .avatar-round, .av-admin, .av-mod, .av-default
 *
 * Role'a göre gradient:
 * - Admin: amber (#c8875a → #a06840)
 * - Mod: yeşil (#6fb07a → #4d8a5a)
 * - Varsayılan: amber brand
 *
 * avatarUrl varsa resim, yoksa ilk harf gösterilir.
 * Boyut (size) runtime'da hesaplandığı için inline style ile verilir.
 */

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

function Avatar({ name, role, avatarUrl, size = 30, isCircle = false }: AvatarProps) {
  const roundClass = isCircle ? "avatar avatar-round" : "avatar";
  const fontSize = size * 0.37;

  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
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
