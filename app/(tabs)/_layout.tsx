// app/(tabs)/_layout.tsx
import { Tabs } from 'expo-router';
import React from 'react';

import { HapticTab } from '@/components/haptic-tab';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { t } from '@/lib/i18n';

export default function TabLayout() {
  const colorScheme = useColorScheme();

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: Colors[colorScheme ?? 'light'].tint,
        headerShown: false,
        tabBarButton: HapticTab,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: t('tabs.home'),
          tabBarIcon: ({ color }) => (
            <IconSymbol size={28} name="house.fill" color={color} />
          ),
        }}
      />

      {/* 注意：history 是一个文件夹路由，因此 Tab 指向 history/index */}
      <Tabs.Screen
        name="history/index"
        options={{
          title: t('tabs.history'),
          tabBarIcon: ({ color }) => (
            <IconSymbol size={28} name="clock.fill" color={color} />
          ),
        }}
      />

      {/* 详情页不应该出现在 TabBar 上 */}
      <Tabs.Screen
        name="history/[id]"
        options={{
          href: null,
        }}
      />

      <Tabs.Screen
        name="settings"
        options={{
          title: t('tabs.settings'),
          tabBarIcon: ({ color }) => (
            <IconSymbol size={28} name="gearshape.fill" color={color} />
          ),
        }}
      />

      {/* Pro 洞察说明页不应该出现在 TabBar 上 */}
      <Tabs.Screen
        name="pro-insight"
        options={{
          href: null,
        }}
      />

      {/* Feedback 页面不应该出现在 TabBar 上 */}
      <Tabs.Screen
        name="feedback"
        options={{
          href: null,
        }}
      />

      {/* Analysis 页面 */}
      <Tabs.Screen
        name="analysis"
        options={{
          title: t('tabs.analysis'),
          tabBarIcon: ({ color }) => (
            <IconSymbol size={28} name="chart.bar.fill" color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
