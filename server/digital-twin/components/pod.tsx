import { BoxShell, useBlink, Plate, type TwinComponentProps } from "@osiris/twin-sdk";

/**
 * React Three Fiber component for a Pod (`dtmi:osiris:k8s:Pod;3`):
 * Shows network activity LED and CPU/memory load fill from Redis cache (`props.data`).
 */
export default function PodTwin(props: TwinComponentProps) {
  const { box, data, ap, colors } = props;
  const led = useBlink(ap, box.center[0], true);
  const cpuLoad = Math.max(0, Math.min(1, Number(data.cpu ?? 0)));

  return (
    <BoxShell {...props}>
      {cpuLoad > 0 && (
        <mesh position={[0, -box.size[1] * (1 - cpuLoad) * 0.5, 0]}>
          <boxGeometry args={[box.size[0] * 0.94, Math.max(0.02, box.size[1] * cpuLoad * 0.94), box.size[2] * 0.94]} />
          <meshBasicMaterial transparent color={colors.cyan} opacity={0.22 * ap.fade} depthWrite={false} />
        </mesh>
      )}
      <Plate
        plateRef={led}
        size={[Math.min(0.22, box.size[0] * 0.12), Math.min(0.22, box.size[1] * 0.12)]}
        position={[box.size[0] * 0.36, box.size[1] * 0.36, box.size[2] / 2 + 0.01]}
        color={ap.status}
        opacity={0.9 * ap.fade}
      />
    </BoxShell>
  );
}

