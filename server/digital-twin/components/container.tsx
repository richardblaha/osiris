import { Body, Outline, Plate, type TwinComponentProps } from "@osiris/twin-sdk";

export default function ContainerLook(props: TwinComponentProps) {
  const { width, depth, height, color } = props;
  const r = Math.min(width, depth) * 0.44;
  return (
    <group>
      <Body {...props} position={[0, height / 2, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[r, r, height, 6]} />
      </Body>
      <Outline {...props} position={[0, height / 2, 0]}>
        <cylinderGeometry args={[r * 1.04, r * 1.04, height * 1.02, 6]} />
      </Outline>
      <Plate color={color} position={[0, height * 0.72, 0]}>
        <torusGeometry args={[r * 0.96, height * 0.025, 6, 6]} />
      </Plate>
    </group>
  );
}

