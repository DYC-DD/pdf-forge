import type { ReactNode } from "react";

import PublicIcon from "../../shared/ui/PublicIcon";
import DodgeField from "./components/DodgeField";
import DraggableFlipCard from "./components/DraggableFlipCard";
import HeroArtPortal from "./components/HeroArtPortal";
import {
  CloudOffIcon,
  FilesIcon,
  LockIcon,
  PdfFileIcon,
  ScissorsIcon,
  ShieldCheckIcon,
  ShieldLockIcon,
} from "./components/HeroCardIcons";
import TechText from "./components/tech-text/TechText";

function HeroTitleLine({
  text,
  color,
  className = "",
  sweep = true,
}: {
  text: string;
  color: string;
  className?: string;
  sweep?: boolean;
}) {
  return (
    <span className={`hero-title-row ${className}`.trim()} aria-hidden="true">
      <span className="hero-title-base">{text}</span>
      <TechText
        text={text}
        fontSize="inherit"
        fontWeight={800}
        letterSpacing={-0.01}
        color={color}
        accentColor="#dcf59d"
        sweep={sweep}
      />
    </span>
  );
}

function ArtSheetBack({
  icon,
  title,
  description,
  variant,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  variant: "merge" | "split" | "ready";
}) {
  return (
    <div
      className={`art-sheet art-sheet--reverse art-sheet--reverse-${variant}`}
    >
      <div className="art-card-top">
        <span>PDF FORGE</span>
        <span>{variant === "ready" ? "LOCAL" : variant.toUpperCase()}</span>
      </div>
      <div className="art-reverse-icon">{icon}</div>
      <strong className="art-reverse-title">{title}</strong>
      <p className="art-reverse-description">{description}</p>
      <div className="art-reverse-footer">
        <span>MADE SIMPLE</span>
        <PublicIcon name="arrow-up-right" size={13} />
      </div>
    </div>
  );
}

export default function LandingHero() {
  return (
    <section className="hero" aria-labelledby="hero-heading">
      <div className="hero-copy">
        <h1 id="hero-heading" className="hero-tech-title">
          <span className="visually-hidden">PDF Forge，打造你需要的 PDF</span>
          <HeroTitleLine text="PDF Forge" color="#ffffff" />
          <HeroTitleLine
            text="打造你需要的 PDF"
            color="#dcf59d"
            className="hero-title-row--accent"
            sweep={false}
          />
        </h1>
        <p>
          合併多份文件、拆分指定頁面，
          <br />
          所有操作都直接在瀏覽器中完成。
        </p>
      </div>
      <HeroArtPortal>
        <DraggableFlipCard
          className="hero-flip-card--back"
          label="拆分 PDF 卡片，可拖曳；懸停、觸碰或按 Enter 翻面"
          back={
            <ArtSheetBack
              variant="split"
              icon={<ScissorsIcon size={29} />}
              title="只留下需要的頁面"
              description="選取頁面，輕鬆輸出新檔。"
            />
          }
        >
          <div className="art-sheet art-sheet--split">
            <div className="art-card-top">
              <span>02 / EXTRACT</span>
              <ScissorsIcon size={14} />
            </div>
            <div className="art-split-visual" aria-hidden="true">
              <span className="art-split-page">01</span>
              <span className="art-split-page art-split-page--selected">
                02 <PublicIcon name="check" size={10} />
              </span>
              <span className="art-split-page">03</span>
              <span className="art-split-page art-split-page--selected">
                04 <PublicIcon name="check" size={10} />
              </span>
            </div>
            <div className="art-card-caption">
              <strong>拆分 PDF</strong>
              <span>只留下需要的頁面</span>
            </div>
          </div>
        </DraggableFlipCard>
        <DraggableFlipCard
          className="hero-flip-card--middle"
          label="合併 PDF 卡片，可拖曳；懸停、觸碰或按 Enter 翻面"
          back={
            <ArtSheetBack
              variant="merge"
              icon={<FilesIcon size={30} />}
              title="多份，合成一份"
              description="依照你的順序整理文件。"
            />
          }
        >
          <div className="art-sheet art-sheet--merge">
            <div className="art-card-top">
              <span>01 / COMBINE</span>
              <FilesIcon size={14} />
            </div>
            <div className="art-merge-visual" aria-hidden="true">
              <div className="art-merge-papers">
                <span>01</span>
                <span>02</span>
                <span>03</span>
              </div>
              <div className="art-merge-result">
                <PublicIcon
                  name="arrow-narrow-up-dashed"
                  size={13}
                  rotate={180}
                />
                <span>ONE PDF</span>
              </div>
            </div>
            <div className="art-card-caption">
              <strong>合併 PDF</strong>
              <span>多份檔案 · 一份完成</span>
            </div>
          </div>
        </DraggableFlipCard>
        <DraggableFlipCard
          className="hero-flip-card--front"
          label="PDF 文件卡片，可拖曳；懸停、觸碰或按 Enter 翻面"
          back={
            <ArtSheetBack
              variant="ready"
              icon={<ShieldCheckIcon size={30} />}
              title="檔案留在裝置"
              description="全程在瀏覽器內完成，無需上傳。"
            />
          }
        >
          <div className="art-sheet art-sheet--ready">
            <div className="art-card-top">
              <span>PDF FORGE</span>
              <span>READY / 03</span>
            </div>
            <div className="art-ready-symbol">
              <PdfFileIcon size={36} />
              <span>
                <PublicIcon name="check" size={14} />
              </span>
            </div>
            <div className="art-ready-copy">
              <strong>剛剛好的 PDF</strong>
              <span>已準備好下載</span>
            </div>
            <div className="art-ready-progress" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <div className="art-ready-footer">
              <span>
                <ShieldCheckIcon size={12} /> 本機完成
              </span>
              <span>100%</span>
            </div>
          </div>
        </DraggableFlipCard>
        <DodgeField
          className="art-float-field art-float-field--top-left"
          axis="x"
        >
          <div className="art-float art-float--top-left">
            <span className="art-float-icon art-float-icon--blue">
              <ShieldLockIcon size={15} />
            </span>
            免註冊・免安裝
          </div>
        </DodgeField>
        <DodgeField className="art-float-field art-float-field--top" axis="x">
          <div className="art-float art-float--top">
            <span className="art-float-icon art-float-icon--blue">
              <LockIcon size={15} />
            </span>
            免費使用
          </div>
        </DodgeField>
        <DodgeField
          className="art-float-field art-float-field--bottom-right"
          axis="x"
        >
          <div className="art-float art-float--bottom-right">
            <span className="art-float-icon art-float-icon--blue">
              <CloudOffIcon size={15} />
            </span>
            檔案不上傳
          </div>
        </DodgeField>
      </HeroArtPortal>
    </section>
  );
}
