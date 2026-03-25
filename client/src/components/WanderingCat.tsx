import { useEffect, useRef, useState } from "react";

const CHIP_WIDTH = 256;
const CHIP_HEIGHT = 215;
const SPRITE_COLUMNS = 4;
const SPRITE_ROWS = 4;
const SPRITE_URL = "/cat-sprite.png";

const CAT_FRAMES = {
  rightWalk1: 0,
  rightWalk2: 1,
  rightWalk3: 2,
  rightWalk4: 3,
  leftWalk1: 4,
  leftWalk2: 5,
  leftWalk3: 6,
  leftWalk4: 7,
  front: 8,
  rightToFront: 12,
  leftToFront: 13,
} as const;

const RIGHT_WALK_SEQUENCE = [CAT_FRAMES.rightWalk1, CAT_FRAMES.rightWalk2, CAT_FRAMES.rightWalk3, CAT_FRAMES.rightWalk4] as const;
const LEFT_WALK_SEQUENCE = [CAT_FRAMES.leftWalk1, CAT_FRAMES.leftWalk2, CAT_FRAMES.leftWalk3, CAT_FRAMES.leftWalk4] as const;
const TURN_RIGHT_TO_LEFT_SEQUENCE = [CAT_FRAMES.rightToFront, CAT_FRAMES.front, CAT_FRAMES.leftToFront] as const;
const TURN_LEFT_TO_RIGHT_SEQUENCE = [CAT_FRAMES.leftToFront, CAT_FRAMES.front, CAT_FRAMES.rightToFront] as const;

type Direction = "right" | "left";
type Mode = "walk" | "front" | "turn";

type CatState = {
  x: number;
  y: number;
  mode: Mode;
  frame: number;
  walkIndex: number;
  turnIndex: number;
  frameElapsed: number;
  modeElapsed: number;
  behaviorElapsed: number;
  nextDirectionShift: number;
  walkDirection: Direction;
  pendingDirection: Direction;
  turnSequence: readonly number[];
  targetY: number;
  nextTurnX: number;
  hasSpawned: boolean;
};

const randomBetween = (min: number, max: number) => Math.random() * (max - min) + min;

// Tweak this constant to control horizontal movement amount.
const CAT_MOVE_X_PX_PER_SEC = 120;
const CAT_MOVE_Y_EASE_PX_PER_SEC = 42;
const TURN_POINT_MIN_DISTANCE = 110;
const TURN_POINT_MAX_DISTANCE = 320;
const CAT_SPRINT_MULTIPLIER = 2.2;
const SEARCH_AVOID_SELECTOR = '[data-cat-avoid-zone="search"]';
const SEARCH_AVOID_PADDING = 18;

type Rect = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};

const getVisualScale = (viewportWidth: number) => {
  if (viewportWidth < 640) return 0.34;
  if (viewportWidth < 1024) return 0.40;
  return 0.48;
};

const getFramePosition = (frame: number) => {
  const row = Math.floor(frame / SPRITE_COLUMNS);
  const col = frame % SPRITE_COLUMNS;
  return {
    backgroundX: -(col * CHIP_WIDTH),
    backgroundY: -(row * CHIP_HEIGHT),
  };
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

const getWalkSequence = (direction: Direction) => {
  return direction === "right" ? RIGHT_WALK_SEQUENCE : LEFT_WALK_SEQUENCE;
};

const getTurnSequence = (fromDirection: Direction) => {
  return fromDirection === "right" ? TURN_RIGHT_TO_LEFT_SEQUENCE : TURN_LEFT_TO_RIGHT_SEQUENCE;
};

const getNextTurnX = (x: number, direction: Direction, maxX: number) => {
  const distance = randomBetween(TURN_POINT_MIN_DISTANCE, TURN_POINT_MAX_DISTANCE);
  const next = direction === "right" ? x + distance : x - distance;
  return clamp(next, 0, maxX);
};

const intersects = (a: Rect, b: Rect) => {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
};

const makeBlackTransparent = (img: HTMLImageElement) => {
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    return null;
  }

  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    // Treat near-black background as transparent while preserving colored pixels.
    if (r <= 10 && g <= 10 && b <= 10) {
      data[i + 3] = 0;
    }
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL("image/png");
};

export function WanderingCat() {
  const catRef = useRef<HTMLDivElement | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [useFallback, setUseFallback] = useState(false);
  const [spriteSrc, setSpriteSrc] = useState(SPRITE_URL);

  const stateRef = useRef<CatState>({
    x: 36,
    y: 120,
    mode: "walk",
    frame: CAT_FRAMES.rightWalk1,
    walkIndex: 0,
    turnIndex: 0,
    frameElapsed: 0,
    modeElapsed: 0,
    behaviorElapsed: 0,
    nextDirectionShift: randomBetween(1.4, 3.2),
    walkDirection: "right",
    pendingDirection: "right",
    turnSequence: TURN_RIGHT_TO_LEFT_SEQUENCE,
    targetY: 120,
    nextTurnX: 300,
    hasSpawned: false,
  });

  const viewportRef = useRef({
    width: typeof window !== "undefined" ? window.innerWidth : 1280,
    height: typeof window !== "undefined" ? window.innerHeight : 720,
    scrollY: typeof window !== "undefined" ? window.scrollY : 0,
    pageHeight: typeof document !== "undefined" ? Math.max(document.body.scrollHeight, document.documentElement.scrollHeight) : 720,
    scale: typeof window !== "undefined" ? getVisualScale(window.innerWidth) : 0.48,
  });

  useEffect(() => {
    let retryId: number | null = null;

    const tryLoadSprite = () => {
      const img = new Image();
      img.onload = () => {
        const processed = makeBlackTransparent(img);
        if (processed) {
          setSpriteSrc(processed);
        } else {
          setSpriteSrc(SPRITE_URL);
        }
        setUseFallback(false);
        setIsReady(true);
      };
      img.onerror = () => {
        setUseFallback(true);
        setIsReady(true);
      };
      img.src = `${SPRITE_URL}?t=${Date.now()}`;
    };

    tryLoadSprite();

    // When the sprite file is added later during dev, auto-switch from fallback.
    if (useFallback) {
      retryId = window.setInterval(tryLoadSprite, 2000);
    }

    return () => {
      if (retryId != null) {
        window.clearInterval(retryId);
      }
    };
  }, [useFallback]);

  useEffect(() => {
    if (!isReady) return;

    const handleResize = () => {
      viewportRef.current.width = window.innerWidth;
      viewportRef.current.height = window.innerHeight;
      viewportRef.current.scrollY = window.scrollY;
      viewportRef.current.pageHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      viewportRef.current.scale = getVisualScale(window.innerWidth);

      const maxX = Math.max(0, viewportRef.current.width - CHIP_WIDTH * viewportRef.current.scale);
      const maxY = Math.max(0, viewportRef.current.pageHeight - CHIP_HEIGHT * viewportRef.current.scale);
      const state = stateRef.current;

      if (!state.hasSpawned) {
        state.x = randomBetween(0, maxX);
        state.y = randomBetween(0, maxY);
        state.targetY = randomBetween(0, maxY);
        state.walkDirection = Math.random() < 0.5 ? "right" : "left";
        state.pendingDirection = state.walkDirection;
        state.turnSequence = getTurnSequence(state.walkDirection);
        state.walkIndex = 0;
        state.frame = getWalkSequence(state.walkDirection)[0];
        state.nextTurnX = getNextTurnX(state.x, state.walkDirection, maxX);
        state.hasSpawned = true;
      }

      state.x = clamp(state.x, 0, maxX);
      state.y = clamp(state.y, 0, maxY);
      state.targetY = clamp(state.targetY, 0, maxY);
      state.nextTurnX = clamp(state.nextTurnX, 0, maxX);
    };

    const setVisual = () => {
      const el = catRef.current;
      if (!el) return;

      const { x, y, frame } = stateRef.current;
      const { backgroundX, backgroundY } = getFramePosition(frame);
      const scale = viewportRef.current.scale;
      const renderY = y - viewportRef.current.scrollY;

      el.style.transform = `translate3d(${x}px, ${renderY}px, 0) scale(${scale}, ${scale})`;
      if (!useFallback) {
        el.style.backgroundPosition = `${backgroundX}px ${backgroundY}px`;
      }
    };

    const resolveSearchAvoidRect = (): Rect | null => {
      const zone = document.querySelector<HTMLElement>(SEARCH_AVOID_SELECTOR);
      if (!zone) return null;

      const rect = zone.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;

      const docTop = rect.top + window.scrollY;
      const docLeft = rect.left;
      return {
        left: Math.max(0, docLeft - SEARCH_AVOID_PADDING),
        right: Math.min(viewportRef.current.width, rect.right + SEARCH_AVOID_PADDING),
        top: Math.max(0, docTop - SEARCH_AVOID_PADDING),
        bottom: docTop + rect.height + SEARCH_AVOID_PADDING,
      };
    };

    handleResize();
    window.addEventListener("resize", handleResize);

    const tick = (time: number) => {
      if (lastTimeRef.current == null) {
        lastTimeRef.current = time;
      }

      const dt = Math.min((time - (lastTimeRef.current ?? time)) / 1000, 0.05);
      lastTimeRef.current = time;

      const state = stateRef.current;
      viewportRef.current.scrollY = window.scrollY;
      viewportRef.current.pageHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      const scaledWidth = CHIP_WIDTH * viewportRef.current.scale;
      const scaledHeight = CHIP_HEIGHT * viewportRef.current.scale;
      const maxX = Math.max(0, viewportRef.current.width - scaledWidth);
      const maxY = Math.max(0, viewportRef.current.pageHeight - scaledHeight);
      const viewportTop = viewportRef.current.scrollY;
      const viewportBottom = viewportTop + viewportRef.current.height;
      const isOffscreen = state.y + scaledHeight < viewportTop - 24 || state.y > viewportBottom + 24;
      const moveMultiplier = isOffscreen ? CAT_SPRINT_MULTIPLIER : 1;
      const avoidRect = resolveSearchAvoidRect();

      const startTurn = (nextDirection: Direction) => {
        if (nextDirection === state.walkDirection) {
          return;
        }

        state.mode = "turn";
        state.modeElapsed = 0;
        state.frameElapsed = 0;
        state.turnIndex = 0;
        state.pendingDirection = nextDirection;
        state.turnSequence = getTurnSequence(state.walkDirection);
        state.frame = state.turnSequence[0];
      };

      if (state.mode === "walk") {
        const xSign = state.walkDirection === "right" ? 1 : -1;
        state.x += CAT_MOVE_X_PX_PER_SEC * moveMultiplier * xSign * dt;

        const yGap = state.targetY - state.y;
        const yStep = CAT_MOVE_Y_EASE_PX_PER_SEC * moveMultiplier * dt;
        if (Math.abs(yGap) <= yStep) {
          state.y = state.targetY;
        } else {
          state.y += Math.sign(yGap) * yStep;
        }

        let bounced = false;
        if (state.x <= 0 || state.x >= maxX) {
          state.x = clamp(state.x, 0, maxX);
          bounced = true;
        }

        state.y = clamp(state.y, 0, maxY);

        if (avoidRect) {
          const catRect: Rect = {
            left: state.x,
            right: state.x + scaledWidth,
            top: state.y,
            bottom: state.y + scaledHeight,
          };

          if (intersects(catRect, avoidRect)) {
            const moveUp = Math.abs(catRect.bottom - avoidRect.top) < Math.abs(avoidRect.bottom - catRect.top);
            state.y = moveUp
              ? clamp(avoidRect.top - scaledHeight - 6, 0, maxY)
              : clamp(avoidRect.bottom + 6, 0, maxY);
            state.targetY = state.y;
            startTurn(state.walkDirection === "right" ? "left" : "right");
          }
        }

        state.behaviorElapsed += dt;
        const hitRandomTurnPoint =
          (state.walkDirection === "right" && state.x >= state.nextTurnX) ||
          (state.walkDirection === "left" && state.x <= state.nextTurnX);

        if (bounced) {
          startTurn(state.walkDirection === "right" ? "left" : "right");
        } else if (hitRandomTurnPoint) {
          startTurn(state.walkDirection === "right" ? "left" : "right");
        } else if (state.behaviorElapsed >= state.nextDirectionShift) {
          state.behaviorElapsed = 0;
          state.nextDirectionShift = randomBetween(1.4, 3.2);
          state.targetY = randomBetween(0, maxY);

          if (Math.random() < 0.28) {
            state.mode = "front";
            state.modeElapsed = 0;
            state.frame = CAT_FRAMES.front;
          }
        }

        if (isOffscreen) {
          state.targetY = clamp(randomBetween(viewportTop + viewportRef.current.height * 0.2, viewportBottom - viewportRef.current.height * 0.2), 0, maxY);
          state.mode = "walk";
        }

        state.frameElapsed += dt;
        if (state.frameElapsed >= (isOffscreen ? 0.055 : 0.095)) {
          const walkSequence = getWalkSequence(state.walkDirection);
          state.walkIndex = (state.walkIndex + 1) % walkSequence.length;
          state.frame = walkSequence[state.walkIndex];
          state.frameElapsed = 0;
        }
      } else if (state.mode === "front") {
        if (isOffscreen) {
          state.mode = "walk";
          state.modeElapsed = 0;
          state.walkIndex = 0;
          state.frame = getWalkSequence(state.walkDirection)[0];
        }
        state.frame = CAT_FRAMES.front;
        state.modeElapsed += dt;

        if (state.modeElapsed >= 0.8) {
          state.mode = "walk";
          state.modeElapsed = 0;
          state.frameElapsed = 0;
          state.walkIndex = 0;
          state.frame = getWalkSequence(state.walkDirection)[0];
          state.nextTurnX = getNextTurnX(state.x, state.walkDirection, maxX);
        }
      } else {
        state.modeElapsed += dt;
        state.frameElapsed += dt;

        if (state.frameElapsed >= 0.12) {
          state.turnIndex += 1;
          state.frameElapsed = 0;

          if (state.turnIndex >= state.turnSequence.length) {
            state.walkDirection = state.pendingDirection;
            state.mode = "walk";
            state.walkIndex = 0;
            state.frame = getWalkSequence(state.walkDirection)[0];
            state.modeElapsed = 0;
            state.targetY = randomBetween(0, maxY);
            state.nextTurnX = getNextTurnX(state.x, state.walkDirection, maxX);
          } else {
            state.frame = state.turnSequence[state.turnIndex];
          }
        }
      }

      setVisual();
      rafIdRef.current = window.requestAnimationFrame(tick);
    };

    setVisual();
    rafIdRef.current = window.requestAnimationFrame(tick);

    return () => {
      window.removeEventListener("resize", handleResize);
      if (rafIdRef.current != null) {
        window.cancelAnimationFrame(rafIdRef.current);
      }
      lastTimeRef.current = null;
    };
  }, [isReady, useFallback]);

  if (!isReady) return null;

  return (
    <div className="pointer-events-none fixed inset-0 z-40 overflow-hidden" aria-hidden="true">
      <div
        ref={catRef}
        className={useFallback ? "wandering-cat-sprite wandering-cat-sprite--fallback" : "wandering-cat-sprite"}
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: `${CHIP_WIDTH}px`,
          height: `${CHIP_HEIGHT}px`,
          backgroundImage: useFallback ? "none" : `url(${spriteSrc})`,
          backgroundSize: `${CHIP_WIDTH * SPRITE_COLUMNS}px ${CHIP_HEIGHT * SPRITE_ROWS}px`,
          backgroundRepeat: "no-repeat",
          transformOrigin: "top left",
          willChange: "transform, background-position",
          backgroundPosition: "0px 0px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: useFallback ? "148px" : undefined,
        }}
      >
        {useFallback ? "🐈" : null}
      </div>
    </div>
  );
}
