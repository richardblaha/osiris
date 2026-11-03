import { BuiltinLook, type TwinComponentProps } from "@osiris/twin-sdk";

export default function RouterLook(props: TwinComponentProps) {
  return <BuiltinLook look="router" {...props} />;
}

