import { Body, Outline, Plate, type TwinComponentProps } from "@osiris/twin-sdk";

export default function CylinderLook(props: TwinComponentProps) {
  const { width, depth, height, color } = props;
  const r = Math.min(width, depth) * 0.44;
  const h = height * 0.3;
  const gap = height * 0.04;
  return (
    <group>
      {[0, 1, 2].map((i) => {
        const y = h / 2 + i * (h + gap);
        return (
          <group key={i} position={[0, y, 0]}>
            <Body {...props} castShadow receiveShadow>
              <cylinderGeometry args={[r, r, h, 28]} />
            </Body>
            <Plate color={color} position={[0, h / 2 - 0.01, 0]}>
              <cylinderGeometry args={[r * 0.92, r * 0.92, 0.025, 28]} />
            </Plate>
          </group>
        );
      })}
      <Outline {...props} position={[0, height / 2, 0]}>
        <cylinderGeometry args={[r * 1.04, r * 1.04, height * 1.02, 28]} />
      </Outline>
    </group>
  );
}

