import PublicIcon from "../../shared/ui/PublicIcon";

export default function SiteFooter() {
  const currentYear = new Date().getFullYear();
  const copyrightYears = currentYear > 2026 ? `2026-${currentYear}` : "2026";

  return (
    <footer className="site-footer">
      <span className="site-footer-tagline">
        PDF Forge | Your PDFs shouldn’t be harder to organize than your life.
      </span>
      <span className="site-footer-copyright">
        <span className="site-footer-compact-brand">PDF Forge |</span>{" "}
        <PublicIcon name="copyright" size={14} />{" "}
        <span>
          {copyrightYears} All rights reserved. -{" "}
          <a href="https://github.com/DYC-DD" target="_blank" rel="noreferrer">
            DENG
          </a>
        </span>
      </span>
    </footer>
  );
}
