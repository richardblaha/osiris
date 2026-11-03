import { BuiltinLook, type TwinComponentProps } from "@osiris/twin-sdk";

export default function CoreLook(props: TwinComponentProps) {
  return <BuiltinLook look="core" {...props} />;
}

