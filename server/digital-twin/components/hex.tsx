import { BuiltinLook, type TwinComponentProps } from "@osiris/twin-sdk";

export default function HexLook(props: TwinComponentProps) {
  return <BuiltinLook look="hex" {...props} />;
}

