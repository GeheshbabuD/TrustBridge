import { randomUUID } from "node:crypto";

const safeRequestId = /^[A-Za-z0-9_-]{1,64}$/;

export const requestIdMiddleware = (request, response, next) => {
  const suppliedId = request.get("x-request-id");
  const requestId = suppliedId && safeRequestId.test(suppliedId) ? suppliedId : randomUUID();

  request.requestId = requestId;
  response.setHeader("X-Request-Id", requestId);
  next();
};
