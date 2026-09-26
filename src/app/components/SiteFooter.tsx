import PublicIcon from "../../shared/ui/PublicIcon";

export default function SiteFooter() {
  return (
    <footer className="site-footer">
      <span>© PDF Forge. 把文件整理，變成一件簡單的事。</span>
      <span>
        <PublicIcon name="lock" size={14} /> 你的檔案，始終由你掌握。
      </span>
    </footer>
  );
}
