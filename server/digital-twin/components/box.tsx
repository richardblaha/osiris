import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import type * as THREE from "three";
import { BoxShell, type TwinComponentProps } from "@osiris/twin-sdk";

/**
 * Default React Three Fiber component for a DTDL twin (`box`).
 * Receives live cached values from Redis in `props.data` and DTDL properties in `props.twin`.
 */
export default function BoxTwin(props: TwinComponentProps) {
  const { box, data, ap, colors } = props;
  const fill = Math.max(0, Math.min(1, Number(data.load ?? data.fill ?? ap.fill ?? 0)));
  const spin = Number(data.spin ?? 0);
  const innerRef = useRef<THREE.Mesh>(null);

  useFrame((_, delta) => {
    if (innerRef.current && spin) {
      innerRef.current.rotation.y += delta * spin;
    }
  });

  return (
    <BoxShell {...props}>
      {fill > 0 && (
        <mesh ref={innerRef} position={[0, -box.size[1] * (1 - fill) * 0.5, 0]}>
          <boxGeometry args={[box.size[0] * 0.92, Math.max(0.02, box.size[1] * fill * 0.92), box.size[2] * 0.92]} />
          <meshBasicMaterial transparent color={ap.fillColor || colors.cyan} opacity={ap.fillOpacity} depthWrite={false} />
        </mesh>
      )}
    </BoxShell>
  );
}

