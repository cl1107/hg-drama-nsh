import { signal, View, Text, Image, type JSX } from "nsh";
import { Button as BaseButton, Input, Tooltip } from "nsh/base";
import { Icon, type IconName } from "./icons";

function textTooltip(text: string) {
  return (
    <Tooltip delay={300} class="rounded-md bg-card border border-border px-2.5 py-1.5" style={{ maxWidth: 320 }}>
      <Text class="text-xs text-foreground">{text}</Text>
    </Tooltip>
  );
}

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
 // 收起态：图标与收起按钮同轴（px-3）；展开态：子项相对分组标签再右缩一级（pl-5）。
 const pad = () => (props.collapsed ? "px-3" : "pl-5 pr-3");
 return <BaseButton testID={props.testID} accessibilityLabel={props.label} tooltip={props.collapsed ? props.label : undefined} selected={props.selected} onPress={props.onPress}
  class={`${pad()} rounded-lg h-10 flex-row items-center gap-3 ${props.selected ? "bg-selection focus:border-ring" : "hover:bg-muted active:opacity-70 focus:border-ring"}`}>
  <Icon name={props.icon ?? "compass"} color={props.selected ? "primary" : "muted-foreground"} size={18} />
  <If when={!props.collapsed}><Text class={props.selected ? "text-sm font-medium text-primary" : "text-sm text-muted-foreground"}>{props.label}</Text></If>
 </BaseButton>;
}

// 与 SidebarItem 同参（px-3、h-10、18px 图标），保证侧栏图标列垂直中线一致。
export function SidebarIconButton(props: {
  icon: IconName;
  label: string;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <BaseButton
      testID={props.testID}
      accessibilityLabel={props.label}
      tooltip={props.label}
      onPress={props.onPress}
      class="h-10 flex-row items-center self-start rounded-lg px-3 hover:bg-muted active:opacity-70 focus:border-ring"
    >
      <Icon name={props.icon} color="muted-foreground" size={18} />
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
        returnKeyType="search"
        submitBehavior="submit"
        onSubmit={() => props.onSubmit?.()}
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
  const topThree = () => props.rank !== undefined && props.rank <= 3;
  return (
    <View class="flex-row items-center gap-4 py-3 px-2 border-b border-border">
      <If when={props.rank !== undefined}>
        <Text
          tooltip={props.rank !== undefined ? `第 ${props.rank} 名` : undefined}
          class={`w-7 text-center text-base font-semibold ${topThree() ? "text-primary" : "text-rating"}`}
        >{String(props.rank ?? "")}</Text>
      </If>
      <If when={!!props.cover}>
        <Image src={props.cover ?? ""} style={{ width: 68, height: 100, borderRadius: 8 }} />
      </If>
      <View class="flex-1 gap-1.5 py-1">
        <View tooltip={textTooltip(props.title)}>
          <Text class="text-base font-semibold text-foreground" style={{ numberOfLines: 1 }}>{props.title}</Text>
        </View>
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
  title: string; cover?: string; subtitle: string; badge?: string; tagsLine?: string; actionLabel: string; actionTestID?: string; onAction: () => void;
  onHome?: () => void; width?: number;
}) {
  const hovered = signal(false);
  const meta = () => props.badge ?? "";
  return (
    <View
      class="gap-2"
      style={{ width: props.width ?? 172 }}
      onMouseEnter={() => hovered.set(true)}
      onMouseLeave={() => hovered.set(false)}
    >
      <View class="relative rounded-lg bg-muted overflow-hidden" style={{ width: "100%", aspectRatio: 0.72 }}>
        <BaseButton
          testID={props.actionTestID}
          accessibilityLabel={`${props.actionLabel} ${props.title}`}
          onPress={props.onAction}
          class="absolute inset-0 active:opacity-80 focus:border-ring"
        >
          <If when={!!props.cover}><Image src={props.cover ?? ""} style={{ width: "100%", height: "100%", objectFit: "cover" }} /></If>
          <View class="absolute bottom-0 left-0 right-0 bg-media-scrim flex-row items-center justify-between px-2 py-1.5">
            <Text class="text-xs text-media-foreground" style={{ numberOfLines: 1 }}>{props.subtitle}</Text>
            <If when={!!meta()}><Text class="text-xs font-medium text-media-foreground">{meta()}</Text></If>
          </View>
        </BaseButton>
        <If when={hovered()}>
          <View class="absolute inset-0 bg-media-scrim items-center justify-center gap-2">
            <BaseButton onPress={props.onAction} class="flex-row items-center gap-1.5 rounded-full bg-primary px-5 py-2 active:opacity-80">
              <Icon name="play" color="primary-foreground" size={14} />
              <Text class="text-sm font-medium text-primary-foreground">{props.actionLabel}</Text>
            </BaseButton>
            <If when={!!props.onHome}>
              <BaseButton onPress={props.onHome} accessibilityLabel={`主页 ${props.title}`} class="rounded-full bg-background px-5 py-2 active:opacity-80">
                <Text class="text-sm font-medium text-foreground">主页</Text>
              </BaseButton>
            </If>
          </View>
        </If>
      </View>
      <If when={!!props.onHome}>
        <BaseButton onPress={() => props.onHome?.()} tooltip={textTooltip(props.title)} class="self-start max-w-full hover:opacity-80 active:opacity-60 focus:border-ring">
          <Text class="text-sm text-foreground" style={{ numberOfLines: 1 }}>{props.title}</Text>
        </BaseButton>
      </If>
      <If when={!props.onHome}>
        <View tooltip={textTooltip(props.title)}>
          <Text class="text-sm text-foreground" style={{ numberOfLines: 1 }}>{props.title}</Text>
        </View>
      </If>
      <If when={!!props.tagsLine}><Text class="text-xs text-muted-foreground" style={{ numberOfLines: 1 }}>{props.tagsLine}</Text></If>
    </View>
  );
}
