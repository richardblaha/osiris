import { useMemo } from "react";
import * as THREE from "three";
import { BoxShell, type TwinComponentProps } from "@osiris/twin-sdk";

/**
 * React Three Fiber component for a Cluster (`dtmi:osiris:k8s:Cluster;3`):
 * Draws the outer translucent shell and a cyan floor grid.
 */
export default function ClusterTwin(props: TwinComponentProps) {
  const { box, ap, colors } = props;
  const grid = useMemo(() => {
    const span = Math.max(box.size[0], box.size[2]);
    const g = new THREE.GridHelper(span, Math.max(4, Math.round(span / 2)), colors.cyan, colors.cyan);
    g.scale.set(box.size[0] / span, 1, box.size[2] / span);
    const mat = g.material as THREE.LineBasicMaterial;
    mat.transparent = true;
    mat.depthWrite = false;
    return g;
  }, [box.size[0], box.size[2], colors.cyan]);

  (grid.material as THREE.LineBasicMaterial).opacity = 0.14 * ap.fade;

  return (
    <BoxShell {...props}>
      <primitive object={grid} position={[0, -box.size[1] / 2 + 0.01, 0]} />
    </BoxShell>
  );
}

