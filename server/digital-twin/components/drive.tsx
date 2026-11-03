import { BuiltinLook, type TwinComponentProps } from "@osiris/twin-sdk";

export default function DriveLook(props: TwinComponentProps) {
  return <BuiltinLook look="drive" {...props} />;
}

