import PublicIcon, { type PublicIconName } from "../../../shared/ui/PublicIcon";

type HeroCardIconProps = {
  size?: number;
};

function HeroCardIcon({
  name,
  size = 24,
}: HeroCardIconProps & { name: PublicIconName }) {
  return <PublicIcon name={name} size={size} className="hero-card-icon" />;
}

export function PdfFileIcon(props: HeroCardIconProps) {
  return <HeroCardIcon name="file-type-pdf" {...props} />;
}

export function FilesIcon(props: HeroCardIconProps) {
  return <HeroCardIcon name="files" {...props} />;
}

export function ScissorsIcon(props: HeroCardIconProps) {
  return <HeroCardIcon name="scissors" {...props} />;
}

export function CompressIcon(props: HeroCardIconProps) {
  return <HeroCardIcon name="compress" {...props} />;
}

export function ShieldCheckIcon(props: HeroCardIconProps) {
  return <HeroCardIcon name="shield-check" {...props} />;
}

export function CloudOffIcon(props: HeroCardIconProps) {
  return <HeroCardIcon name="cloud-off" {...props} />;
}

export function LockIcon(props: HeroCardIconProps) {
  return <HeroCardIcon name="lock" {...props} />;
}

export function ShieldLockIcon(props: HeroCardIconProps) {
  return <HeroCardIcon name="shield-lock" {...props} />;
}
