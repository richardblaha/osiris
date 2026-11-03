import { BuiltinLook, type TwinComponentProps } from "@osiris/twin-sdk";

export default function GateLook(props: TwinComponentProps) {
  return <BuiltinLook look="gate" {...props} />;
}

