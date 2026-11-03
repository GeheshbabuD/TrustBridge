const validErrorCode = /^[A-Z][A-Z0-9_]{1,63}$/;

export class ApiError extends Error {
  constructor(statusCode, code, message) {
    super(message);

    if (!Number.isInteger(statusCode) || statusCode < 400 || statusCode > 599) {
      throw new TypeError("ApiError statusCode must be an HTTP error status");
    }
    if (!validErrorCode.test(code)) {
      throw new TypeError("ApiError code must be a stable uppercase identifier");
    }

    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class AuthServiceError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = "AuthServiceError";
    this.statusCode = statusCode;
    this.code = code;
  }
}
