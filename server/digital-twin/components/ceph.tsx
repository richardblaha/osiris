import { BuiltinLook, type TwinComponentProps } from "@osiris/twin-sdk";

export default function CephLook(props: TwinComponentProps) {
  return <BuiltinLook look="ceph" {...props} />;
}

