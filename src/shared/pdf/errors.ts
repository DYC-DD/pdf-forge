export function fileError(error: unknown): string {
  if (error instanceof Error && error.message.startsWith('這份 PDF 無法以空密碼開啟')) {
    return error.message
  }
  if (error instanceof Error && /encrypt|password/i.test(error.message)) {
    return '這份 PDF 需要開啟密碼，目前無法直接處理。'
  }
  return error instanceof Error ? error.message : '處理檔案時發生錯誤。'
}
