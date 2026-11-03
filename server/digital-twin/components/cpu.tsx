import { BuiltinLook, type TwinComponentProps } from "@osiris/twin-sdk";

export default function CpuLook(props: TwinComponentProps) {
  return <BuiltinLook look="cpu" {...props} />;
}

