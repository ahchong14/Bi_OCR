/**
 * 带 HTTP 状态码的业务错误。code 是语言无关的错误代码,由 onError 按请求头 x-lang 翻译成中文或英文。
 * params 用来填充提示里的变量(比如字段名、行号)。
 */
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    public params: Record<string, string | number> = {},
  ) {
    super(code)
  }
}
