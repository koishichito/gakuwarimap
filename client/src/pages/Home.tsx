import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { MemphisBackground } from "@/components/MemphisDecorations";
import { SpotCard } from "@/components/SpotCard";
import { CategoryIcon, getCategoryBgColor } from "@/components/CategoryIcon";
import { MapView } from "@/components/Map";
import { MapPin, Search, ArrowRight, Sparkles, Navigation } from "lucide-react";
import { cn } from "@/lib/utils";

export default function Home() {
  const [, navigate] = useLocation();
  const [searchQuery, setSearchQuery] = useState("");
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markersRef = useRef<google.maps.marker.AdvancedMarkerElement[]>([]);

  // Default to Tokyo
  const [mapCenter] = useState({ lat: 35.6812, lng: 139.7671 });

  // Get user location
  useEffect(() => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          setUserLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        },
        () => {
          // Use default Tokyo location
        }
      );
    }
  }, []);

  const { data: categoriesData } = trpc.category.list.useQuery();
  const categories = categoriesData ?? [];

  const queryCenter = userLocation ?? mapCenter;
  const { data: nearbyData, isLoading: nearbyLoading } = trpc.spot.nearby.useQuery({
    lat: queryCenter.lat,
    lng: queryCenter.lng,
    radiusKm: 50,
    limit: 20,
  });

  const nearbySpots = nearbyData ?? [];

  // Build category lookup
  const categoryMap = useMemo(() => {
    const map = new Map<number, (typeof categories)[0]>();
    categories.forEach((c) => map.set(c.id, c));
    return map;
  }, [categories]);

  // Map markers
  const handleMapReady = useCallback((map: google.maps.Map) => {
    mapRef.current = map;
  }, []);

  useEffect(() => {
    if (!mapRef.current || nearbySpots.length === 0) return;

    // Clear old markers
    markersRef.current.forEach((m) => (m.map = null));
    markersRef.current = [];

    const bounds = new google.maps.LatLngBounds();

    nearbySpots.forEach((spot) => {
      const lat = typeof spot.lat === "string" ? parseFloat(spot.lat) : spot.lat;
      const lng = typeof spot.lng === "string" ? parseFloat(spot.lng) : spot.lng;
      if (isNaN(lat) || isNaN(lng)) return;

      const cat = categoryMap.get(spot.categoryId);
      const pinColor = cat?.color === "mint" ? "#6ee7b7" : cat?.color === "lilac" ? "#c4b5fd" : cat?.color === "yellow" ? "#fde047" : cat?.color === "coral" ? "#fb923c" : "#f9a8d4";

      const pinEl = document.createElement("div");
      pinEl.style.cssText = `width:32px;height:32px;border-radius:50%;background:${pinColor};border:2px solid #1a1a1a;display:flex;align-items:center;justify-content:center;font-size:14px;cursor:pointer;box-shadow:2px 2px 0px #1a1a1a;`;
      pinEl.textContent = "📍";

      const marker = new google.maps.marker.AdvancedMarkerElement({
        map: mapRef.current!,
        position: { lat, lng },
        title: spot.name,
        content: pinEl,
      });

      // Info window
      const infoWindow = new google.maps.InfoWindow({
        content: `<div style="font-family:Poppins,sans-serif;padding:4px;max-width:200px;">
          <strong style="font-size:14px;">${spot.name}</strong>
          <p style="font-size:12px;color:#666;margin:4px 0;">${spot.discountDetail}</p>
          ${spot.discountRate ? `<span style="background:#fde047;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:600;">${spot.discountRate}</span>` : ""}
        </div>`,
      });

      marker.addListener("click", () => {
        infoWindow.open({ anchor: marker, map: mapRef.current });
      });

      markersRef.current.push(marker);
      bounds.extend({ lat, lng });
    });

    if (nearbySpots.length > 0) {
      mapRef.current.fitBounds(bounds, { top: 50, right: 50, bottom: 50, left: 50 });
    }
  }, [nearbySpots, categoryMap]);

  // Center map on user location
  useEffect(() => {
    if (mapRef.current && userLocation) {
      mapRef.current.setCenter(userLocation);
      mapRef.current.setZoom(14);
    }
  }, [userLocation]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      navigate(`/search?q=${encodeURIComponent(searchQuery.trim())}`);
    }
  };

  return (
    <div className="min-h-screen pb-20 md:pb-0">
      {/* Hero Section */}
      <section className="relative overflow-hidden py-10 sm:py-16 md:py-20">
        <MemphisBackground count={30} />
        <div className="container relative z-10">
          <div className="max-w-2xl mx-auto text-center">
            <div className="inline-flex items-center gap-2 bg-memphis-mint/30 border-2 border-foreground rounded-full px-4 py-1.5 mb-4 shadow-[2px_2px_0px_oklch(0.15_0.01_0)]">
              <Sparkles size={14} />
              <span className="text-xs font-bold uppercase tracking-wider">学生のための割引情報</span>
            </div>
            <h1 className="text-4xl sm:text-5xl md:text-6xl font-black uppercase tracking-tight leading-[1.1] mb-4" style={{ textShadow: "3px 3px 0px oklch(0.87 0.12 165 / 0.5)" }}>
              学割マップ
            </h1>
            <p className="text-base sm:text-lg text-muted-foreground font-medium mb-6 max-w-lg mx-auto">
              近くの学割スポットを見つけて、お得に楽しもう。みんなの口コミで、もっと便利に。
            </p>

            {/* Search bar */}
            <form onSubmit={handleSearch} data-cat-avoid-zone="search" className="flex gap-2 max-w-md mx-auto">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={18} />
                <Input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="店名・エリアで検索..."
                  className="pl-10 h-12 border-2 border-foreground rounded-xl text-base shadow-[3px_3px_0px_oklch(0.15_0.01_0)]"
                />
              </div>
              <Button type="submit" className="memphis-btn h-12 px-5 rounded-xl bg-primary text-primary-foreground">
                <Search size={18} />
              </Button>
            </form>
          </div>
        </div>
      </section>

      {/* Categories */}
      <section className="py-6 sm:py-8">
        <div className="container">
          <h2 className="text-lg sm:text-xl font-extrabold uppercase tracking-tight mb-4">カテゴリ</h2>
          <div className="flex gap-2 overflow-x-auto pb-2 -mx-4 px-4 sm:mx-0 sm:px-0 sm:flex-wrap scrollbar-hide">
            {categories.length === 0
              ? Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="w-24 h-20 rounded-xl shrink-0" />
                ))
              : categories.map((cat) => (
                  <button
                    key={cat.id}
                    onClick={() => navigate(`/spots?category=${cat.id}`)}
                    className={cn(
                      "flex flex-col items-center gap-1.5 px-4 py-3 rounded-xl border-2 border-foreground shrink-0 transition-all",
                      "shadow-[2px_2px_0px_oklch(0.15_0.01_0)] hover:shadow-[3px_3px_0px_oklch(0.15_0.01_0)] hover:translate-x-[-1px] hover:translate-y-[-1px]",
                      getCategoryBgColor(cat.color)
                    )}
                  >
                    <CategoryIcon icon={cat.icon} size={22} />
                    <span className="text-xs font-bold whitespace-nowrap">{cat.name}</span>
                  </button>
                ))}
          </div>
        </div>
      </section>

      {/* Map Section */}
      <section className="py-4 sm:py-6">
        <div className="container">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg sm:text-xl font-extrabold uppercase tracking-tight">マップ</h2>
            {!userLocation && (
              <Button
                variant="outline"
                size="sm"
                className="memphis-btn text-xs bg-memphis-mint/30"
                onClick={() => {
                  navigator.geolocation?.getCurrentPosition((pos) => {
                    setUserLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude });
                  });
                }}
              >
                <Navigation size={14} className="mr-1" />
                現在地を取得
              </Button>
            )}
          </div>
          <div className="rounded-xl overflow-hidden border-2 border-foreground shadow-[4px_4px_0px_oklch(0.15_0.01_0)]">
            <MapView
              className="h-[300px] sm:h-[400px]"
              initialCenter={queryCenter}
              initialZoom={13}
              onMapReady={handleMapReady}
            />
          </div>
        </div>
      </section>

      {/* Nearby Spots */}
      <section className="py-6 sm:py-8">
        <div className="container">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg sm:text-xl font-extrabold uppercase tracking-tight">
              {userLocation ? "近くのスポット" : "おすすめスポット"}
            </h2>
            <Button
              variant="ghost"
              size="sm"
              className="text-primary font-bold text-sm"
              onClick={() => navigate("/spots")}
            >
              すべて見る
              <ArrowRight size={14} className="ml-1" />
            </Button>
          </div>

          {nearbyLoading ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-64 rounded-xl" />
              ))}
            </div>
          ) : nearbySpots.length === 0 ? (
            <div className="text-center py-12 bg-card rounded-xl border-2 border-foreground shadow-[4px_4px_0px_oklch(0.15_0.01_0)]">
              <MapPin size={48} className="mx-auto text-muted-foreground/30 mb-3" />
              <p className="text-muted-foreground font-medium">まだスポットが登録されていません</p>
              <Button
                className="memphis-btn mt-4 bg-primary text-primary-foreground"
                onClick={() => navigate("/submit")}
              >
                最初のスポットを投稿する
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {nearbySpots.slice(0, 6).map((spot) => (
                <SpotCard
                  key={spot.id}
                  spot={spot}
                  category={categoryMap.get(spot.categoryId) ?? null}
                  distance={(spot as any).distance ?? null}
                />
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
