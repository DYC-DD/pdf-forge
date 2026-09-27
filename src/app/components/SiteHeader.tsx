export default function SiteHeader() {
  return (
    <header className="site-header">
      <a
        className="brand"
        href={import.meta.env.BASE_URL}
        aria-label="PDF Forge 首頁"
      >
        <span className="brand-mark">
          <img
            src={`${import.meta.env.BASE_URL}icons/file-type-pdf.svg`}
            alt=""
          />
        </span>
        <span>
          PDF <strong>Forge</strong>
        </span>
      </a>
    </header>
  );
}
