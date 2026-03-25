import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectCandidateShops,
  getAgentCacheKeyForPlace,
  parseAgentResultContent,
  searchNearbyPlaces,
} from "./agent";
import { makeRequest } from "./_core/map";

vi.mock("./_core/map", () => ({
  makeRequest: vi.fn(),
}));

const mockedMakeRequest = vi.mocked(makeRequest);
const ORIGINAL_ENV = { ...process.env };

function createPlace(
  name: string,
  lat: number,
  lng: number,
  {
    placeId = name,
    type = "store",
    rating,
    address,
  }: {
    placeId?: string;
    type?: string;
    rating?: number;
    address?: string;
  } = {}
) {
  return {
    name,
    formatted_address: address ?? name,
    place_id: placeId,
    geometry: {
      location: {
        lat,
        lng,
      },
    },
    rating,
    types: [type],
  };
}

beforeEach(() => {
  process.env = {
    ...ORIGINAL_ENV,
    DEPLOY_MODE: "external",
    GOOGLE_MAPS_SERVER_API_KEY: "google-test-key",
  };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetAllMocks();
});

describe("parseAgentResultContent", () => {
  it("parses plain JSON", () => {
    expect(
      parseAgentResultContent(
        '{"has_gakuwari":true,"discount_info":"10% off","source_url":"https://example.com","confidence":"high"}'
      )
    ).toEqual({
      has_gakuwari: true,
      discount_info: "10% off",
      source_url: "https://example.com",
      confidence: "high",
    });
  });

  it("parses fenced JSON", () => {
    expect(
      parseAgentResultContent(
        '```json\n{"has_gakuwari":false,"discount_info":"","source_url":"","confidence":"medium"}\n```'
      )
    ).toEqual({
      has_gakuwari: false,
      discount_info: "",
      source_url: "",
      confidence: "medium",
    });
  });

  it("falls back to text heuristics for malformed content", () => {
    expect(
      parseAgentResultContent(
        "Student discount available at the counter. https://example.com/info"
      )
    ).toEqual({
      has_gakuwari: true,
      discount_info:
        "Student discount available at the counter. https://example.com/info",
      source_url: "https://example.com/info",
      confidence: "low",
    });
  });
});

describe("searchNearbyPlaces address fallback", () => {
  it("prefers formatted_address when it is present", async () => {
    mockedMakeRequest.mockResolvedValueOnce({
      status: "OK",
      results: [
        {
          name: "Shop A",
          formatted_address: "Tokyo",
          vicinity: "Shibuya",
          place_id: "place_a",
          geometry: {
            location: {
              lat: 35.6,
              lng: 139.7,
            },
          },
          types: ["store"],
        },
      ],
    } as never);
    mockedMakeRequest.mockResolvedValueOnce({
      status: "ZERO_RESULTS",
      result: {},
    } as never);

    const shops = await searchNearbyPlaces(35.6, 139.7);

    expect(shops[0]?.address).toBe("Tokyo");
  });

  it("falls back to vicinity when formatted_address is missing", async () => {
    mockedMakeRequest.mockResolvedValueOnce({
      status: "OK",
      results: [
        {
          name: "Shop B",
          vicinity: "Shinjuku",
          place_id: "place_b",
          geometry: {
            location: {
              lat: 35.7,
              lng: 139.7,
            },
          },
          types: ["store"],
        },
      ],
    } as never);
    mockedMakeRequest.mockResolvedValueOnce({
      status: "ZERO_RESULTS",
      result: {},
    } as never);

    const shops = await searchNearbyPlaces(35.7, 139.7);

    expect(shops[0]?.address).toBe("Shinjuku");
  });
});

describe("collectCandidateShops", () => {
  it("merges multiple search profiles, paginates, dedupes, and keeps only in-radius results", async () => {
    mockedMakeRequest.mockImplementation(async (endpoint, params) => {
      if (endpoint === "/maps/api/place/nearbysearch/json") {
        const request = params as Record<string, unknown>;
        const pageToken = String(request.pagetoken ?? "");
        const type = String(request.type ?? "");

        if (pageToken === "broad-page-2") {
          return {
            status: "OK",
            results: [
              createPlace("Cinema Prime", 35.6599, 139.7006, {
                placeId: "cinema-prime",
                type: "movie_theater",
                rating: 4.7,
              }),
            ],
          } as never;
        }

        if (!type) {
          return {
            status: "OK",
            next_page_token: "broad-page-2",
            results: [
              createPlace("Cafe Nearby", 35.6596, 139.7004, {
                placeId: "cafe-nearby",
                type: "cafe",
                rating: 4.2,
              }),
              createPlace("Duplicate Cafe", 35.6597, 139.7005, {
                placeId: "duplicate-cafe",
                type: "cafe",
                rating: 4.1,
              }),
              createPlace("Outside Radius", 35.6895, 139.7005, {
                placeId: "outside-radius",
                type: "movie_theater",
                rating: 4.9,
              }),
            ],
          } as never;
        }

        if (type === "movie_theater") {
          return {
            status: "OK",
            results: [
              createPlace("Duplicate Cafe", 35.6597, 139.7005, {
                placeId: "duplicate-cafe",
                type: "movie_theater",
                rating: 4.3,
              }),
            ],
          } as never;
        }

        return {
          status: "ZERO_RESULTS",
          results: [],
        } as never;
      }

      throw new Error(`Unexpected endpoint: ${String(endpoint)}`);
    });

    const candidates = await collectCandidateShops(35.6595, 139.7005, 500, "映画");

    expect(candidates.map((candidate) => candidate.place_id)).toEqual([
      "cinema-prime",
      "duplicate-cafe",
      "cafe-nearby",
    ]);
    expect(candidates.some((candidate) => candidate.place_id === "outside-radius")).toBe(
      false
    );
    expect(
      mockedMakeRequest.mock.calls.some(
        ([, params]) => (params as Record<string, unknown>).pagetoken === "broad-page-2"
      )
    ).toBe(true);
  });
});

describe("getAgentCacheKeyForPlace", () => {
  it("includes the strategy version prefix", () => {
    expect(getAgentCacheKeyForPlace("place_123")).toBe(
      "agent-team-v1::place_123"
    );
  });
});
