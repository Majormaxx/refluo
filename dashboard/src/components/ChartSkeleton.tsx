import { Skeleton } from "@/components/ui/skeleton";

const BAR_HEIGHTS = ["45%", "75%", "55%", "90%", "65%", "35%"];

/** A chart-shaped placeholder, not generic text-line bars — matches the
 * real charts' fixed `h-48` height so swapping it for the real
 * `ChartContainer` once data arrives causes no layout shift. */
export function ChartSkeleton() {
  return (
    <div className="flex h-48 w-full items-end gap-2 px-2">
      {BAR_HEIGHTS.map((height, i) => (
        <Skeleton key={i} className="flex-1" style={{ height }} />
      ))}
    </div>
  );
}
