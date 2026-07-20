import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Alert } from "@/components/ui/alert";
import type { AgentLifecycleStatus } from "@getpaseo/protocol/agent-lifecycle";
import { deriveOpenCodeStallState, useOpenCodeStallClock } from "./opencode-stall";

interface OpenCodeStallNoticeProps {
  provider: string | null | undefined;
  status: AgentLifecycleStatus;
  lastActivityAt: Date | string | number | null | undefined;
  childActivityAt?: readonly (Date | string | number | null | undefined)[];
  isWaitingForInput?: boolean;
  useParentRecoveryControls?: boolean;
  testID?: string;
}

export function OpenCodeStallNotice({
  provider,
  status,
  lastActivityAt,
  childActivityAt,
  isWaitingForInput,
  useParentRecoveryControls = false,
  testID = "opencode-stall-warning",
}: OpenCodeStallNoticeProps) {
  const { t } = useTranslation();
  const nowMs = useOpenCodeStallClock(provider === "opencode" && status === "running");
  const stall = deriveOpenCodeStallState({
    provider,
    status,
    lastActivityAt,
    childActivityAt,
    isWaitingForInput,
    nowMs,
  });
  if (!stall.possiblyStalled || stall.inactiveMinutes === null) return null;

  return (
    <View style={styles.container} testID={`${testID}-container`}>
      <Alert
        variant="warning"
        description={`${t("subagents.stallWarning", { count: stall.inactiveMinutes })}${
          useParentRecoveryControls ? ` ${t("subagents.stallParentRecovery")}` : ""
        }`}
        testID={testID}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    width: "100%",
    maxWidth: 860,
    alignSelf: "center",
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[3],
  },
}));
