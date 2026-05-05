import { randomUUID } from "node:crypto";

export function createResponseId() {
  return `resp_${randomUUID().replaceAll("-", "")}`;
}

export function createMessageId() {
  return `msg_${randomUUID().replaceAll("-", "")}`;
}

export function createCallId() {
  return `call_${randomUUID().replaceAll("-", "")}`;
}
