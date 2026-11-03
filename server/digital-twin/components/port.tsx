import { BuiltinLook, type TwinComponentProps } from "@osiris/twin-sdk";

export default function PortLook(props: TwinComponentProps) {
  return <BuiltinLook look="port" {...props} />;
}

