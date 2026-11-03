import { AssetModel, BoxShell, Plate, TextPlate, useBlink, type TwinComponentProps } from "@osiris/twin-sdk";

/**
 * React Three Fiber component for a Machine / Node (`dtmi:osiris:k8s:Node;3`):
 * Translucent mini-PC chassis, status/network activity LED on the front face, and name plate.
 */
export default function NodeTwin(props: TwinComponentProps) {
  const { box, ap, colors } = props;
  const led = useBlink(ap, box.center[0] + box.center[2], true);

  return (
    <BoxShell {...props}>
      <AssetModel name="mini-pc.glb" size={box.size} fit="stretch" color={ap.body} opacity={0.18 * ap.fade} />
      <Plate
        plateRef={led}
        size={[Math.min(0.35, box.size[0] * 0.04), Math.min(0.18, box.size[1] * 0.12)]}
        position={[box.size[0] * 0.38, box.size[1] * 0.25, box.size[2] / 2 + 0.01]}
        color={ap.status}
        opacity={0.9 * ap.fade}
      />
      <TextPlate {...props} />
    </BoxShell>
  );
}

