export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export const notFound = (what: string) => new HttpError(404, "not_found", `${what} not found`);
export const forbidden = (msg = "forbidden") => new HttpError(403, "forbidden", msg);
export const badRequest = (msg: string) => new HttpError(400, "bad_request", msg);
export const conflict = (msg: string) => new HttpError(409, "conflict", msg);
