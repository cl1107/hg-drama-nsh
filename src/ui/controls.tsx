import { View, Text, Image, type JSX } from "nsh";
import { Button as BaseButton, Input } from "nsh/base";
import { Icon, type IconName } from "./icons";

export type ButtonVariant = "primary" | "outline" | "ghost" | "destructive";
export type ButtonSize = "sm" | "md";

export function Button(props: {
  label?: string;
  testID?: string;
  onPress: () => void;
  selected?: boolean;
  disabled?: boolean;
  variant?: ButtonVariant;
  size?: ButtonSize;
  class?: string;
  children?: JSX.Element;
}) {
  const variant = () => (props.selected ? "primary" : props.variant ?? "ghost");
  const sizeClass = () => (props.size === "sm" ? "px-3 py-1.5" : "px-4 py-2.5");
  const bgClass = () => {
    const v = variant();
    if (v === "primary") return "bg-primary hover:opacity-90 active:opacity-80";
    if (v === "destructive") return "bg-destructive hover:opacity-90 active:opacity-80";
    if (v === "outline") return "border border-border bg-card hover:bg-muted active:opacity-80";
    return "hover:bg-muted active:opacity-70";
  };
  const textClass = () => {
    const v = variant();
    if (v === "primary") return "text-primary-foreground font-medium";
    if (v === "destructive") return "text-destructive-foreground font-medium";
    return "text-foreground";
  };

  return (
    <BaseButton
      testID={props.testID}
      onPress={props.onPress}
      disabled={props.disabled}
      class={`rounded-lg items-center justify-center focus:border-ring disabled:opacity-40 ${sizeClass()} ${bgClass()} ${props.class ?? ""}`}
    >
      <If when={props.label !== undefined}>
        <Text class={`text-sm ${textClass()}`}>{props.label ?? ""}</Text>
      </If>
      {props.children}
    </BaseButton>
  );
}

export function SidebarItem(props: {
  label: string; shortLabel: string; collapsed: boolean; selected: boolean; onPress: () => void; testID?: string; icon?: IconName;
}) {
 return <BaseButton testID={props.testID} accessibilityLabel={props.label} tooltip={props.collapsed ? props.label : undefined} selected={props.selected} onPress={props.onPress}
  class={props.selected ? "rounded-lg bg-selection px-3 h-10 flex-row items-center gap-3 focus:border-ring" : "rounded-lg px-3 h-10 flex-row items-center gap-3 hover:bg-muted active:opacity-70 focus:border-ring"}>
  <Icon name={props.icon ?? "compass"} color={props.selected ? "primary" : "muted-foreground"} size={18} />
  <If when={!props.collapsed}><Text class={props.selected ? "text-sm font-medium text-primary" : "text-sm text-muted-foreground"}>{props.label}</Text></If>
 </BaseButton>;
}

export function PageHeader(props: {
  title: string;
  subtitle?: string;
  actions?: JSX.Element;
}) {
  return (
    <View class="flex-row items-center justify-between gap-4 pb-2 border-b border-border">
      <View class="gap-0.5">
        <Text class="text-xl font-semibold text-foreground">{props.title}</Text>
        <If when={!!props.subtitle}>
          <Text class="text-xs text-muted-foreground">{props.subtitle ?? ""}</Text>
        </If>
      </View>
      <If when={!!props.actions}>
        <View class="flex-row items-center gap-2">{props.actions}</View>
      </If>
    </View>
  );
}

export function SearchField(props: {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: () => void;
  onClear?: () => void;
  placeholder: string;
  submitLabel?: string;
  testID?: string;
}) {
  return (
    <View class="flex-row items-center gap-2">
      <Input
        testID={props.testID}
        class="flex-1 bg-card border border-input rounded-lg px-3.5 py-2.5 text-sm text-foreground focus:border-ring"
        value={props.value}
        onChange={({ value }) => props.onChange(value)}
        placeholder={props.placeholder}
      />
      <If when={!!props.value && !!props.onClear}>
        <Button label="清空" variant="ghost" size="sm" onPress={() => props.onClear?.()} />
      </If>
      <If when={!!props.onSubmit}>
        <Button label={props.submitLabel ?? "搜索"} variant="primary" onPress={() => props.onSubmit?.()} />
      </If>
    </View>
  );
}

export function FilterChip(props: {
  label: string;
  selected: boolean;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <BaseButton
      testID={props.testID}
      onPress={props.onPress}
      class={
        props.selected
          ? "rounded-full border border-primary bg-selection px-3 py-1 focus:border-ring"
          : "rounded-full border border-transparent px-3 py-1 hover:bg-muted focus:border-ring"
      }
    >
      <Text class={props.selected ? "text-xs font-medium text-primary" : "text-xs text-muted-foreground"}>
        {props.label}
      </Text>
    </BaseButton>
  );
}

export function StatusView(props: {
  kind: "loading" | "empty" | "error";
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <View class="flex-1 items-center justify-center p-8 gap-3">
      <Text class={props.kind === "error" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
        {props.message}
      </Text>
      <If when={!!props.actionLabel && !!props.onAction}>
        <Button
          label={props.actionLabel ?? "重试"}
          variant="outline"
          size="sm"
          onPress={() => props.onAction?.()}
        />
      </If>
    </View>
  );
}

export function DramaListRow(props: {
  rank?: number;
  title: string;
  cover?: string;
  subtitle: string;
  rating?: string;
  actionLabel: string;
  actionTestID?: string;
  onAction: () => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
}) {
  return (
    <View class="flex-row items-center gap-4 py-3 px-2 border-b border-border">
      <If when={props.rank !== undefined}>
        <Text class="w-7 text-center text-base font-semibold text-rating">{String(props.rank ?? "")}</Text>
      </If>
      <If when={!!props.cover}>
        <Image src={props.cover ?? ""} style={{ width: 68, height: 100, borderRadius: 8 }} />
      </If>
      <View class="flex-1 gap-1.5 py-1">
        <Text class="text-base font-semibold text-foreground">{props.title}</Text>
        <Text class="text-xs text-muted-foreground">{props.subtitle}</Text>
        <If when={!!props.rating}>
          <Text class="text-xs font-medium text-rating">{props.rating ?? ""}</Text>
        </If>
      </View>
      <View class="flex-row items-center gap-2">
        <If when={!!props.secondaryLabel && !!props.onSecondary}>
          <Button label={props.secondaryLabel ?? ""} variant="outline" size="sm" onPress={() => props.onSecondary?.()} />
        </If>
        <Button testID={props.actionTestID} label={props.actionLabel} variant="primary" size="sm" onPress={props.onAction} />
      </View>
    </View>
  );
}

export function PosterCard(props: {
  title: string; cover?: string; subtitle: string; badge?: string; actionLabel: string; actionTestID?: string; onAction: () => void;
  secondaryLabel?: string; onSecondary?: () => void; width?: number;
}) {
 return <View class="gap-2" style={{ width: props.width ?? 172 }}>
  <BaseButton testID={props.actionTestID} accessibilityLabel={`${props.actionLabel} ${props.title}`} onPress={props.onAction} class="gap-2 items-stretch rounded-lg active:opacity-80 focus:border-ring">
   <View class="relative rounded-lg bg-muted overflow-hidden" style={{ width: "100%", aspectRatio: 0.72 }}>
    <If when={!!props.cover}><Image src={props.cover ?? ""} style={{ width: "100%", height: "100%", objectFit: "cover" }} /></If>
    <View class="absolute bottom-0 left-0 right-0 bg-media-scrim px-2 py-1.5"><Text class="text-xs text-media-foreground" style={{ numberOfLines: 1 }}>{props.subtitle}</Text></View>
   </View>
   <Text class="text-sm text-foreground" style={{ numberOfLines: 1 }}>{props.title}</Text>
  </BaseButton>
  <View class="flex-row items-center justify-between">
   <If when={!!props.badge}><Text class="text-xs font-medium text-rating">{props.badge ?? ""}</Text></If>
   <If when={!!props.secondaryLabel && !!props.onSecondary}><BaseButton onPress={() => props.onSecondary?.()} accessibilityLabel={`${props.secondaryLabel} ${props.title}`} class="py-1 active:opacity-60"><Text class="text-xs text-muted-foreground">{props.secondaryLabel ?? ""}</Text></BaseButton></If>
  </View>
 </View>;
}
