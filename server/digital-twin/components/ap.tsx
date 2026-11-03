import { BuiltinLook, type TwinComponentProps } from "@osiris/twin-sdk";

export default function AccessPointLook(props: TwinComponentProps) {
  return <BuiltinLook look="ap" {...props} />;
}

