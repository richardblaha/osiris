import { BuiltinLook, type TwinComponentProps } from "@osiris/twin-sdk";

export default function MemoryLook(props: TwinComponentProps) {
  return <BuiltinLook look="memory" {...props} />;
}

