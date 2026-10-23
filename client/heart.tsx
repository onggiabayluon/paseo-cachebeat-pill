import type { PluginButtonIconProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Text } from "react-native";

/** Outline heart: the cache is tracked but cachebeat is not keeping it warm. */
export function HeartOutline({ size, color }: PluginButtonIconProps) {
  return <Icon name="Heart" size={size} color={color} />;
}

/** Solid heart: cachebeat is on. Lucide has no filled variant, so draw the glyph. */
export function HeartFilled({ size, color }: PluginButtonIconProps) {
  return (
    <Text style={{ color, fontSize: size, lineHeight: size + 2, includeFontPadding: false }}>
      {"♥︎"}
    </Text>
  );
}
