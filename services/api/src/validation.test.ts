import { describe, expect, it } from "vitest";
import { isValidRepositorySlug } from "./validation.js";

describe("isValidRepositorySlug", () => {
  it.each([
    "owner/repo",
    "mehtahet619/Multiplayer-coding-agent",
    "org_name/repo.name",
    "owner-name/repo_name",
  ])("accepts a valid owner/repository value: %s", (value) => {
    expect(isValidRepositorySlug(value)).toBe(true);
  });

  it.each([
    "",
    "owner",
    "/repo",
    "owner/",
    "owner/repo/extra",
    "owner/repo name",
    "https://github.com/owner/repo",
    "owner\\repo",
  ])("rejects an invalid repository value: %s", (value) => {
    expect(isValidRepositorySlug(value)).toBe(false);
  });
});
