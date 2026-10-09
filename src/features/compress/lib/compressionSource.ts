import {
  detectSources,
  inspectImageBytes,
  type ImageInfo,
} from "../../convert/lib/imageSource";

export type CompressionSource =
  { kind: "pdf"; file: File } | { kind: "image"; file: File; info: ImageInfo };

export async function detectCompressionSource(
  files: readonly File[]
): Promise<CompressionSource> {
  if (files.length !== 1) throw new Error("一次只能加入一個檔案。");
  const kind = await detectSources(files);
  const file = files[0];
  if (kind === "pdf")
    return {
      kind,
      file: /\.pdf$/i.test(file.name)
        ? file
        : new File([file], `${file.name}.pdf`, { type: "application/pdf" }),
    };
  const info = inspectImageBytes(new Uint8Array(await file.arrayBuffer()));
  return {
    kind: "image",
    file: new File([file], file.name, {
      type: info.format === "jpg" ? "image/jpeg" : "image/png",
    }),
    info,
  };
}
