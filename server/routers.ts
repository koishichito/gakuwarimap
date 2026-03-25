import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  getAllCategories,
  createCategory,
  getSpots,
  getSpotById,
  getNearbySpots,
  createSpot,
  getReviewsBySpotId,
  createReview,
} from "./db";
import {
  searchNearbyPlaces,
  searchGakuwariSpots,
} from "./agent";
import { storagePut } from "./storage";
import { nanoid } from "nanoid";

const MAX_IMAGE_UPLOAD_BYTES = 5 * 1024 * 1024;
const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),

  category: router({
    list: publicProcedure.query(async () => {
      return getAllCategories();
    }),
    create: publicProcedure
      .input(z.object({
        name: z.string().min(1).max(100),
        icon: z.string().min(1).max(50),
        color: z.string().min(1).max(20),
      }))
      .mutation(async ({ input }) => {
        return createCategory(input);
      }),
  }),

  spot: router({
    list: publicProcedure
      .input(z.object({
        categoryId: z.number().optional(),
        search: z.string().optional(),
        limit: z.number().min(1).max(100).optional(),
        offset: z.number().min(0).optional(),
        sortBy: z.enum(["rating", "newest", "name"]).optional(),
      }).optional())
      .query(async ({ input }) => {
        return getSpots(input ?? {});
      }),

    byId: publicProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => {
        const spot = await getSpotById(input.id);
        if (!spot) throw new Error("Spot not found");
        return spot;
      }),

    nearby: publicProcedure
      .input(z.object({
        lat: z.number(),
        lng: z.number(),
        radiusKm: z.number().min(0.1).max(50).optional(),
        limit: z.number().min(1).max(100).optional(),
      }))
      .query(async ({ input }) => {
        return getNearbySpots(input.lat, input.lng, input.radiusKm, input.limit);
      }),

    create: publicProcedure
      .input(z.object({
        name: z.string().min(1).max(200),
        description: z.string().optional(),
        address: z.string().min(1).max(500),
        lat: z.string(),
        lng: z.string(),
        categoryId: z.number(),
        discountDetail: z.string().min(1),
        discountRate: z.string().optional(),
        phone: z.string().optional(),
        website: z.string().optional(),
        openingHours: z.string().optional(),
        imageUrl: z.string().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        return createSpot({
          ...input,
          submittedBy: ctx.user?.id ?? null,
        });
      }),
  }),

  review: router({
    bySpot: publicProcedure
      .input(z.object({ spotId: z.number() }))
      .query(async ({ input }) => {
        return getReviewsBySpotId(input.spotId);
      }),

    create: publicProcedure
      .input(z.object({
        spotId: z.number(),
        userName: z.string().min(1).max(100),
        rating: z.number().min(1).max(5),
        comment: z.string().optional(),
        imageUrl: z.string().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        return createReview({
          ...input,
          userId: ctx.user?.id ?? null,
        });
      }),
  }),

  upload: router({
    image: publicProcedure
      .input(z.object({
        base64: z.string(),
        contentType: z.string(),
        fileName: z.string(),
      }))
      .mutation(async ({ input }) => {
        const buffer = Buffer.from(input.base64, "base64");
        if (buffer.length > MAX_IMAGE_UPLOAD_BYTES) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Image must be 5MB or smaller",
          });
        }

        const contentType = input.contentType.trim().toLowerCase();
        const ext = IMAGE_EXTENSIONS[contentType];

        if (!ext) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Unsupported image type",
          });
        }

        const key = `images/${nanoid()}.${ext}`;
        const { url } = await storagePut(key, buffer, contentType);
        return { url };
      }),
  }),

  agent: router({
    /**
     * 周辺店舗を検索し、Agentで学割情報を自動調査する
     * フロー: Google Maps Places API → Agent Server → 結果マージ
     */
    searchGakuwari: publicProcedure
      .input(z.object({
        lat: z.number(),
        lng: z.number(),
        radius: z.number().min(100).max(5000).optional(),
        keyword: z.string().optional(),
        llmProvider: z.enum(["gemini", "ollama"]).optional(),
      }))
      .mutation(async ({ input }) => {
        const results = await searchGakuwariSpots(
          input.lat,
          input.lng,
          input.radius ?? 500,
          input.keyword,
          input.llmProvider ?? "gemini",
        );
        return { results };
      }),

    /**
     * Google Maps Places APIのみで周辺店舗を取得する（Agent不使用）
     */
    nearbyPlaces: publicProcedure
      .input(z.object({
        lat: z.number(),
        lng: z.number(),
        radius: z.number().min(100).max(5000).optional(),
        keyword: z.string().optional(),
        type: z.string().optional(),
      }))
      .query(async ({ input }) => {
        const shops = await searchNearbyPlaces(
          input.lat,
          input.lng,
          input.radius ?? 500,
          input.keyword,
          input.type,
        );
        return { shops };
      }),
  }),
});

export type AppRouter = typeof appRouter;
