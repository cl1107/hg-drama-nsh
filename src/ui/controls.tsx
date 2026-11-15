import { View, Text, Image, type JSX } from "nsh";
import { Button as BaseButton, Input } from "nsh/base";

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
  label: string;
  shortLabel: string;
  collapsed: boolean;
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
          ? "rounded-lg bg-primary px-3 py-2.5 items-start focus:border-ring"
          : "rounded-lg px-3 py-2.5 items-start hover:bg-muted active:opacity-70 focus:border-ring"
      }
    >
      <Text class={props.selected ? "text-sm font-medium text-primary-foreground" : "text-sm text-foreground"}>
        {props.collapsed ? props.shortLabel : props.label}
      </Text>
    </BaseButton>
  );
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
          ? "rounded-lg bg-primary px-3 py-1.5 focus:border-ring"
          : "rounded-lg bg-card border border-border px-3 py-1.5 hover:bg-muted focus:border-ring"
      }
    >
      <Text class={props.selected ? "text-xs font-medium text-primary-foreground" : "text-xs text-foreground"}>
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
  title: string;
  cover?: string;
  subtitle: string;
  badge?: string;
  actionLabel: string;
  actionTestID?: string;
  onAction: () => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
}) {
  return (
    <View class="bg-card border border-border rounded-xl p-2.5 gap-2" style={{ width: 180 }}>
      <If when={!!props.cover}>
        <Image src={props.cover ?? ""} style={{ width: 158, height: 224, borderRadius: 8 }} />
      </If>
      <View class="gap-1">
        <Text class="text-sm font-semibold text-foreground">{props.title}</Text>
        <View class="flex-row items-center justify-between gap-1">
          <Text class="text-xs text-muted-foreground">{props.subtitle}</Text>
          <If when={!!props.badge}>
            <Text class="text-xs font-medium text-rating">{props.badge ?? ""}</Text>
          </If>
        </View>
      </View>
      <View class="flex-row items-center gap-1.5">
        <Button testID={props.actionTestID} label={props.actionLabel} variant="primary" size="sm" class="flex-1" onPress={props.onAction} />
        <If when={!!props.secondaryLabel && !!props.onSecondary}>
          <Button label={props.secondaryLabel ?? ""} variant="outline" size="sm" onPress={() => props.onSecondary?.()} />
        </If>
      </View>
    </View>
  );
}
