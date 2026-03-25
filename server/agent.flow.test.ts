import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { searchGakuwariSpots } from "./agent";
import { makeRequest } from "./_core/map";

vi.mock("./_core/map", () => ({
  makeRequest: vi.fn(),
}));

const mockedMakeRequest = vi.mocked(makeRequest);
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = {
    ...ORIGINAL_ENV,
    NODE_ENV: "test",
    DEPLOY_MODE: "external",
    GOOGLE_MAPS_SERVER_API_KEY: "google-test-key",
    GEMINI_API_KEY: "gemini-test-key",
    GEMINI_MODEL: "gemini-3-flash-preview",
    GEMINI_OPENAI_BASE_URL: "https://gemini.example.com/v1beta/openai",
  };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

describe("searchGakuwariSpots", () => {
  it("gathers evidence once and preserves the public response shape", async () => {
    mockedMakeRequest.mockResolvedValueOnce({
      status: "OK",
      results: [
        {
          name: "Cafe Alpha",
          formatted_address: "Tokyo",
          place_id: "place_1",
          geometry: {
            location: {
              lat: 35.1,
              lng: 139.1,
            },
          },
          rating: 4.5,
          types: ["cafe"],
        },
      ],
    } as never);
    mockedMakeRequest.mockResolvedValueOnce({
      status: "OK",
      result: {
        website: "https://example.com",
        formatted_address: "Tokyo Chiyoda",
      },
    } as never);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [
              {
                title: "Cafe Alpha Discount",
                url: "https://example.com/discount",
                content: "Student discount available",
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content:
                    '{"has_gakuwari":true,"discount_info":"10% off","source_url":"https://example.com/discount","confidence":"high"}',
                },
                finish_reason: "stop",
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          }
        )
      );

    vi.stubGlobal("fetch", fetchMock);

    const results = await searchGakuwariSpots(35.1, 139.1, 500, "cafe");

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      place_id: "place_1",
      name: "Cafe Alpha",
      address: "Tokyo Chiyoda",
      website: "https://example.com",
      has_gakuwari: true,
      discount_info: "10% off",
      source_url: "https://example.com/discount",
      confidence: "high",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to heuristic parsing when the final answer is not JSON", async () => {
    mockedMakeRequest.mockResolvedValueOnce({
      status: "OK",
      results: [
        {
          name: "Cafe Beta",
          formatted_address: "Osaka",
          place_id: "place_2",
          geometry: {
            location: {
              lat: 34.1,
              lng: 135.1,
            },
          },
          rating: 4.1,
          types: ["cafe"],
        },
      ],
    } as never);
    mockedMakeRequest.mockResolvedValueOnce({
      status: "ZERO_RESULTS",
      result: {},
    } as never);

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              results: [
                {
                  title: "Cafe Beta Discount",
                  url: "https://example.com/discount",
                  content: "Student discount available",
                },
              ],
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            }
          )
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    content:
                      "A student discount is available. Source: https://example.com/discount",
                  },
                  finish_reason: "stop",
                },
              ],
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            }
          )
        )
    );

    const results = await searchGakuwariSpots(34.1, 135.1);

    expect(results[0]?.has_gakuwari).toBe(true);
    expect(results[0]?.confidence).toBe("low");
    expect(results[0]?.discount_info).toContain("student discount");
    expect(results[0]?.source_url).toBe("https://example.com/discount");
  });

  it("returns a low-confidence default when Gemini fails", async () => {
    mockedMakeRequest.mockResolvedValueOnce({
      status: "OK",
      results: [
        {
          name: "Cafe Gamma",
          formatted_address: "Nagoya",
          place_id: "place_3",
          geometry: {
            location: {
              lat: 35.0,
              lng: 136.0,
            },
          },
          rating: 3.9,
          types: ["cafe"],
        },
      ],
    } as never);
    mockedMakeRequest.mockResolvedValueOnce({
      status: "ZERO_RESULTS",
      result: {},
    } as never);

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              results: [],
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            }
          )
        )
        .mockRejectedValueOnce(new Error("network error"))
    );

    const results = await searchGakuwariSpots(35.0, 136.0);

    expect(results[0]).toMatchObject({
      place_id: "place_3",
      has_gakuwari: false,
      discount_info: "",
      source_url: "",
      confidence: "low",
    });
  });

  it("builds a deterministic evidence search query", async () => {
    mockedMakeRequest.mockResolvedValueOnce({
      status: "OK",
      results: [
        {
          name: "Cafe Delta",
          formatted_address: "Kobe",
          place_id: "place_4",
          geometry: {
            location: {
              lat: 34.7,
              lng: 135.2,
            },
          },
          rating: 4.0,
          types: ["cafe"],
        },
      ],
    } as never);
    mockedMakeRequest.mockResolvedValueOnce({
      status: "ZERO_RESULTS",
      result: {},
    } as never);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [
              {
                title: "Cafe Delta",
                url: "https://example.com/cafe-delta",
                content: "No student discount found",
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content:
                    '{"has_gakuwari":false,"discount_info":"","source_url":"","confidence":"low"}',
                },
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          }
        )
      );

    vi.stubGlobal("fetch", fetchMock);

    await searchGakuwariSpots(34.7, 135.2, 500, "cafe");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("Cafe+Delta"),
      expect.any(Object)
    );
  });

  it("uses beauty-specific evidence keywords for hair salons", async () => {
    mockedMakeRequest.mockResolvedValueOnce({
      status: "OK",
      results: [
        {
          name: "Luna Hair",
          formatted_address: "Shibuya",
          place_id: "place_beauty_1",
          geometry: {
            location: {
              lat: 35.66,
              lng: 139.7,
            },
          },
          rating: 4.7,
          types: ["hair_care"],
        },
      ],
    } as never);
    mockedMakeRequest.mockResolvedValueOnce({
      status: "OK",
      result: {
        website: "https://salon.example.com",
        formatted_address: "Shibuya Tokyo",
      },
    } as never);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [
              {
                title: "Luna Hair",
                url: "https://beauty.hotpepper.jp/example",
                content: "学割U24 クーポンあり",
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content:
                    '{"has_gakuwari":true,"discount_info":"学割U24あり","source_url":"https://beauty.hotpepper.jp/example","confidence":"high"}',
                },
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          }
        )
      );

    vi.stubGlobal("fetch", fetchMock);

    const results = await searchGakuwariSpots(35.66, 139.7, 500, "hair");
    const firstUrl = String(fetchMock.mock.calls[0]?.[0] ?? "");

    expect(results[0]).toMatchObject({
      place_id: "place_beauty_1",
      has_gakuwari: true,
      confidence: "high",
    });
    expect(decodeURIComponent(firstUrl)).toContain("学生カット");
    expect(decodeURIComponent(firstUrl)).toContain("学割U24");
    expect(firstUrl).not.toContain("site%3A");
  });

  it("uses broader student-pricing keywords for karaoke venues", async () => {
    mockedMakeRequest.mockResolvedValueOnce({
      status: "OK",
      results: [
        {
          name: "Karaoke Echo",
          formatted_address: "Shibuya",
          place_id: "place_karaoke_1",
          geometry: {
            location: {
              lat: 35.67,
              lng: 139.7,
            },
          },
          rating: 4.3,
          types: ["karaoke"],
        },
      ],
    } as never);
    mockedMakeRequest.mockResolvedValueOnce({
      status: "ZERO_RESULTS",
      result: {},
    } as never);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [
              {
                title: "Karaoke Echo",
                url: "https://example.com/karaoke-student",
                content: "学生料金あり",
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content:
                    '{"has_gakuwari":true,"discount_info":"学生料金あり","source_url":"https://example.com/karaoke-student","confidence":"high"}',
                },
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          }
        )
      );

    vi.stubGlobal("fetch", fetchMock);

    await searchGakuwariSpots(35.67, 139.7, 500, "カラオケ");
    const firstUrl = String(fetchMock.mock.calls[0]?.[0] ?? "");
    const decodedUrl = decodeURIComponent(firstUrl);

    expect(decodedUrl).toContain("カラオケ");
    expect(decodedUrl).toContain("学生料金");
    expect(decodedUrl).toContain("学生フリータイム");
    expect(decodedUrl).toContain("中高生料金");
  });

  it("keeps the nearby result when place details lookup fails", async () => {
    mockedMakeRequest.mockResolvedValueOnce({
      status: "OK",
      results: [
        {
          name: "Cafe Epsilon",
          formatted_address: "Sapporo",
          place_id: "place_5",
          geometry: {
            location: {
              lat: 43.0,
              lng: 141.3,
            },
          },
          rating: 3.8,
          types: ["cafe"],
        },
      ],
    } as never);
    mockedMakeRequest.mockRejectedValueOnce(new Error("details unavailable"));

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              results: [],
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            }
          )
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    content:
                      '{"has_gakuwari":false,"discount_info":"","source_url":"","confidence":"low"}',
                  },
                },
              ],
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            }
          )
        )
    );

    const results = await searchGakuwariSpots(43.0, 141.3);

    expect(results[0]).toMatchObject({
      place_id: "place_5",
      address: "Sapporo",
      website: undefined,
      confidence: "low",
    });
  });

  it("reuses cached results for repeated searches of the same place", async () => {
    mockedMakeRequest
      .mockResolvedValueOnce({
        status: "OK",
        results: [
          {
            name: "Cafe Zeta",
            formatted_address: "Tokyo",
            place_id: "place_6",
            geometry: {
              location: {
                lat: 35.2,
                lng: 139.2,
              },
            },
            rating: 4.2,
            types: ["cafe"],
          },
        ],
      } as never)
      .mockResolvedValueOnce({
        status: "OK",
        result: {
          website: "https://example.com/zeta",
          formatted_address: "Tokyo Minato",
        },
      } as never)
      .mockResolvedValueOnce({
        status: "OK",
        results: [
          {
            name: "Cafe Zeta",
            formatted_address: "Tokyo",
            place_id: "place_6",
            geometry: {
              location: {
                lat: 35.2,
                lng: 139.2,
              },
            },
            rating: 4.2,
            types: ["cafe"],
          },
        ],
      } as never)
      .mockResolvedValueOnce({
        status: "OK",
        result: {
          website: "https://example.com/zeta",
          formatted_address: "Tokyo Minato",
        },
      } as never);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [
              {
                title: "Cafe Zeta Discount",
                url: "https://example.com/zeta-discount",
                content: "Student discount available",
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content:
                    '{"has_gakuwari":true,"discount_info":"5% off","source_url":"https://example.com/zeta-discount","confidence":"medium"}',
                },
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          }
        )
      );

    vi.stubGlobal("fetch", fetchMock);

    await searchGakuwariSpots(35.2, 139.2, 500, "cafe");
    const secondResults = await searchGakuwariSpots(35.2, 139.2, 500, "cafe");

    expect(secondResults[0]).toMatchObject({
      place_id: "place_6",
      has_gakuwari: true,
      confidence: "medium",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
