import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useFocusEffect } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MerunoText } from '@/components/primitives/MerunoText';
import { SectionTitle } from '@/components/SectionTitle';
import { t } from '@/lib/i18n';
import { navigateBackOrHome } from '@/lib/navigationBack';
import {
  addManualShoppingListItem,
  clearCompletedShoppingListItems,
  decrementShoppingListItemQuantity,
  deleteShoppingListItem,
  incrementShoppingListItemQuantity,
  listShoppingListItems,
  SHOPPING_LIST_QUANTITY_MAX,
  SHOPPING_LIST_QUANTITY_MIN,
  toggleShoppingListItemCompleted,
  type ShoppingListItem,
} from '@/lib/shoppingList';
import { UI_COLORS, UI_LAYOUT, UI_RADIUS, UI_SPACING } from '@/lib/uiTokens';

export default function ShoppingListScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [items, setItems] = useState<ShoppingListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const onBack = useCallback(() => {
    navigateBackOrHome(router);
  }, [router]);

  const refresh = useCallback(async () => {
    try {
      const next = await listShoppingListItems();
      setItems(next);
      setLoadFailed(false);
    } catch (error) {
      console.error('[ShoppingList] refresh failed', error);
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      void refresh();
    }, [refresh])
  );

  const incomplete = useMemo(
    () => items.filter((item) => !item.isCompleted),
    [items]
  );
  const completed = useMemo(
    () => items.filter((item) => item.isCompleted),
    [items]
  );
  const canAddManual = draft.trim().length > 0;

  const onAdd = useCallback(async () => {
    if (busy || draft.trim().length === 0) return;
    setBusy(true);
    try {
      const result = await addManualShoppingListItem(draft);
      if (result.status === 'rejected') {
        return;
      }
      setDraft('');
      await refresh();
    } catch (error) {
      console.error('[ShoppingList] add failed', error);
      Alert.alert(t('shoppingList.errorTitle'), t('shoppingList.errorMessage'));
    } finally {
      setBusy(false);
    }
  }, [busy, draft, refresh]);

  const onToggle = useCallback(
    async (id: string) => {
      if (busy) return;
      setBusy(true);
      try {
        const result = await toggleShoppingListItemCompleted(id);
        if (result.status === 'already_active_identity') {
          Alert.alert(t('shoppingList.alreadyOnList'));
          await refresh();
          return;
        }
        await refresh();
      } catch (error) {
        console.error('[ShoppingList] toggle failed', error);
      } finally {
        setBusy(false);
      }
    },
    [busy, refresh]
  );

  const onDelete = useCallback(
    async (id: string) => {
      if (busy) return;
      setBusy(true);
      try {
        await deleteShoppingListItem(id);
        await refresh();
      } catch (error) {
        console.error('[ShoppingList] delete failed', error);
      } finally {
        setBusy(false);
      }
    },
    [busy, refresh]
  );

  const onClearCompleted = useCallback(async () => {
    if (busy || completed.length === 0) return;
    setBusy(true);
    try {
      await clearCompletedShoppingListItems();
      await refresh();
    } catch (error) {
      console.error('[ShoppingList] clear completed failed', error);
    } finally {
      setBusy(false);
    }
  }, [busy, completed.length, refresh]);

  const onIncrement = useCallback(
    async (id: string) => {
      if (busy) return;
      setBusy(true);
      try {
        await incrementShoppingListItemQuantity(id);
        await refresh();
      } catch (error) {
        console.error('[ShoppingList] increment failed', error);
      } finally {
        setBusy(false);
      }
    },
    [busy, refresh]
  );

  const onDecrement = useCallback(
    async (id: string) => {
      if (busy) return;
      setBusy(true);
      try {
        await decrementShoppingListItemQuantity(id);
        await refresh();
      } catch (error) {
        console.error('[ShoppingList] decrement failed', error);
      } finally {
        setBusy(false);
      }
    },
    [busy, refresh]
  );

  const renderItem = (item: ShoppingListItem) => (
    <View key={item.id} style={styles.itemRow}>
      <Pressable
        onPress={() => void onToggle(item.id)}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: item.isCompleted }}
        accessibilityLabel={`${item.text} ×${item.quantity}`}
        hitSlop={8}
        style={({ pressed }) => [
          styles.checkboxHit,
          pressed && styles.pressed,
        ]}
      >
        <MaterialIcons
          name={item.isCompleted ? 'check-box' : 'check-box-outline-blank'}
          size={28}
          color={
            item.isCompleted ? UI_COLORS.accent : UI_COLORS.textSecondary
          }
        />
      </Pressable>
      <MerunoText
        role="bodySmall"
        tone={item.isCompleted ? 'muted' : 'primary'}
        style={[
          styles.itemText,
          item.isCompleted ? styles.itemTextCompleted : null,
        ]}
      >
        {`${item.text} ×${item.quantity}`}
      </MerunoText>
      {!item.isCompleted ? (
        <View style={styles.qtyControls}>
          <Pressable
            onPress={() => void onDecrement(item.id)}
            disabled={busy || item.quantity <= SHOPPING_LIST_QUANTITY_MIN}
            accessibilityRole="button"
            accessibilityLabel={t('shoppingList.decreaseQuantityA11y', {
              quantity: item.quantity,
            })}
            hitSlop={6}
            style={({ pressed }) => [
              styles.qtyButton,
              pressed && styles.pressed,
              (busy || item.quantity <= SHOPPING_LIST_QUANTITY_MIN) &&
                styles.qtyButtonDisabled,
            ]}
          >
            <Text style={styles.qtyButtonText}>−</Text>
          </Pressable>
          <Text style={styles.qtyValue}>{item.quantity}</Text>
          <Pressable
            onPress={() => void onIncrement(item.id)}
            disabled={busy || item.quantity >= SHOPPING_LIST_QUANTITY_MAX}
            accessibilityRole="button"
            accessibilityLabel={t('shoppingList.increaseQuantityA11y', {
              quantity: item.quantity,
            })}
            hitSlop={6}
            style={({ pressed }) => [
              styles.qtyButton,
              pressed && styles.pressed,
              (busy || item.quantity >= SHOPPING_LIST_QUANTITY_MAX) &&
                styles.qtyButtonDisabled,
            ]}
          >
            <Text style={styles.qtyButtonText}>+</Text>
          </Pressable>
        </View>
      ) : null}
      <Pressable
        onPress={() => void onDelete(item.id)}
        accessibilityRole="button"
        accessibilityLabel={t('shoppingList.delete')}
        hitSlop={8}
        style={({ pressed }) => [
          styles.deleteButton,
          pressed && styles.pressed,
        ]}
      >
        <MerunoText role="meta" tone="secondary">
          {t('shoppingList.delete')}
        </MerunoText>
      </Pressable>
    </View>
  );

  return (
    <View
      style={[
        styles.container,
        { paddingTop: insets.top + UI_LAYOUT.safeAreaTopGapCompact },
      ]}
    >
      <View style={styles.header}>
        <Pressable
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel={t('shoppingList.back')}
          style={({ pressed }) => [
            styles.backButton,
            pressed && styles.pressed,
          ]}
          hitSlop={8}
        >
          <Text style={styles.backText}>{t('shoppingList.back')}</Text>
        </Pressable>
        <Text style={styles.headerTitle}>{t('shoppingList.title')}</Text>
        <View style={styles.headerSpacer} />
      </View>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={insets.top}
      >
        <View style={styles.composer}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={t('shoppingList.inputPlaceholder')}
            placeholderTextColor={UI_COLORS.textMuted}
            style={styles.input}
            returnKeyType="done"
            onSubmitEditing={() => void onAdd()}
            editable={!busy}
          />
          <Pressable
            onPress={() => void onAdd()}
            accessibilityRole="button"
            accessibilityLabel={t('shoppingList.add')}
            disabled={busy || !canAddManual}
            style={({ pressed }) => [
              styles.addButton,
              pressed && styles.pressed,
              (busy || !canAddManual) && styles.addButtonDisabled,
            ]}
          >
            <Text style={styles.addButtonText}>{t('shoppingList.add')}</Text>
          </Pressable>
        </View>

        {loading ? (
          <View style={styles.centerState}>
            <ActivityIndicator color={UI_COLORS.accent} />
          </View>
        ) : loadFailed ? (
          <View style={styles.centerState}>
            <MerunoText role="bodySmall" tone="secondary">
              {t('shoppingList.errorMessage')}
            </MerunoText>
          </View>
        ) : items.length === 0 ? (
          <View style={styles.emptyState}>
            <MerunoText role="bodySmall" tone="primary" style={styles.emptyTitle}>
              {t('shoppingList.emptyTitle')}
            </MerunoText>
            <MerunoText role="meta" tone="secondary">
              {t('shoppingList.emptySubtitle')}
            </MerunoText>
          </View>
        ) : (
          <ScrollView
            style={styles.flex}
            contentContainerStyle={[
              styles.content,
              { paddingBottom: insets.bottom + UI_SPACING.xl },
            ]}
            keyboardShouldPersistTaps="handled"
          >
            {incomplete.length > 0 ? (
              <>
                <SectionTitle title={t('shoppingList.incomplete')} />
                <View style={styles.listBlock}>
                  {incomplete.map(renderItem)}
                </View>
              </>
            ) : null}

            {completed.length > 0 ? (
              <>
                <SectionTitle title={t('shoppingList.completed')} />
                <View style={styles.listBlock}>
                  {completed.map(renderItem)}
                </View>
                <Pressable
                  onPress={() => void onClearCompleted()}
                  accessibilityRole="button"
                  accessibilityLabel={t('shoppingList.clearCompleted')}
                  style={({ pressed }) => [
                    styles.clearButton,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.clearButtonText}>
                    {t('shoppingList.clearCompleted')}
                  </Text>
                </Pressable>
              </>
            ) : null}
          </ScrollView>
        )}
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: UI_COLORS.background,
  },
  flex: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: UI_SPACING.lg,
    paddingBottom: UI_SPACING.sm,
  },
  backButton: {
    minWidth: 56,
  },
  backText: {
    color: UI_COLORS.accent,
    fontSize: 17,
    fontWeight: '600',
  },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
    fontSize: 17,
    fontWeight: '700',
    color: UI_COLORS.textPrimary,
  },
  headerSpacer: {
    minWidth: 56,
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: UI_SPACING.sm,
    paddingHorizontal: UI_SPACING.lg,
    paddingVertical: UI_SPACING.md,
  },
  input: {
    flex: 1,
    minHeight: 44,
    borderRadius: UI_RADIUS.control,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: UI_COLORS.border,
    backgroundColor: UI_COLORS.surfaceMuted,
    paddingHorizontal: UI_SPACING.md,
    fontSize: 16,
    color: UI_COLORS.textPrimary,
  },
  addButton: {
    minHeight: 44,
    paddingHorizontal: UI_SPACING.lg,
    borderRadius: UI_RADIUS.control,
    backgroundColor: UI_COLORS.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addButtonDisabled: {
    opacity: 0.55,
  },
  addButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  content: {
    paddingHorizontal: UI_SPACING.lg,
  },
  listBlock: {
    borderRadius: UI_RADIUS.panel,
    backgroundColor: UI_COLORS.surfaceMuted,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: UI_COLORS.border,
    overflow: 'hidden',
    marginBottom: UI_SPACING.md,
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: UI_SPACING.md,
    paddingVertical: 14,
    gap: UI_SPACING.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: UI_COLORS.borderSubtle,
  },
  checkboxHit: {
    paddingTop: 1,
  },
  itemText: {
    flex: 1,
    minWidth: 0,
    lineHeight: 22,
  },
  itemTextCompleted: {
    textDecorationLine: 'line-through',
  },
  qtyControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    flexShrink: 0,
  },
  qtyButton: {
    minWidth: 32,
    minHeight: 32,
    borderRadius: UI_RADIUS.control,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: UI_COLORS.border,
    backgroundColor: UI_COLORS.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qtyButtonDisabled: {
    opacity: 0.4,
  },
  qtyButtonText: {
    fontSize: 18,
    fontWeight: '600',
    color: UI_COLORS.accent,
    lineHeight: 20,
  },
  qtyValue: {
    minWidth: 20,
    textAlign: 'center',
    fontSize: 15,
    fontWeight: '700',
    color: UI_COLORS.textPrimary,
  },
  deleteButton: {
    paddingVertical: 4,
    paddingHorizontal: 4,
  },
  clearButton: {
    alignSelf: 'center',
    paddingVertical: UI_SPACING.md,
    paddingHorizontal: UI_SPACING.lg,
    marginBottom: UI_SPACING.lg,
  },
  clearButtonText: {
    color: UI_COLORS.accent,
    fontSize: 15,
    fontWeight: '600',
  },
  centerState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: UI_SPACING.xl,
  },
  emptyState: {
    paddingHorizontal: UI_SPACING.xl,
    paddingTop: UI_SPACING.xxl,
  },
  emptyTitle: {
    fontWeight: '700',
    marginBottom: UI_SPACING.sm,
  },
  pressed: {
    opacity: 0.55,
  },
});
