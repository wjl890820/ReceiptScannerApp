// app/(tabs)/_layout.tsx
import { Tabs } from 'expo-router';
import React, { useEffect, useState } from 'react';

import { HapticTab } from '@/components/haptic-tab';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { subscribeLocaleChange, t } from '@/lib/i18n';
import { TAB_BAR_PRESENTATION } from '@/lib/tabBarPresentation';
import { resolveTabTitles } from '@/lib/tabTitles';

function readTabTitles() {
  return resolveTabTitles(t);
}

export default function TabLayout() {
  // Refresh labels on locale change (also covers root Stack remount races).
  const [tabTitles, setTabTitles] = useState(readTabTitles);
  useEffect(() => {
    return subscribeLocaleChange(() => {
      setTabTitles(readTabTitles());
    });
  }, []);

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarButton: HapticTab,
        tabBarShowLabel: true,
        tabBarActiveTintColor: TAB_BAR_PRESENTATION.active,
        tabBarInactiveTintColor: TAB_BAR_PRESENTATION.inactive,
        tabBarStyle: {
          backgroundColor: TAB_BAR_PRESENTATION.background,
          borderTopColor: TAB_BAR_PRESENTATION.border,
        },
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: '500',
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: tabTitles.home,
          tabBarLabel: tabTitles.home,
          tabBarIcon: ({ color }) => (
            <IconSymbol size={28} name="house.fill" color={color} />
          ),
        }}
      />

      <Tabs.Screen
        name="analysis"
        options={{
          title: tabTitles.analysis,
          tabBarLabel: tabTitles.analysis,
          tabBarIcon: ({ color }) => (
            <IconSymbol size={28} name="chart.bar.fill" color={color} />
          ),
        }}
      />

      <Tabs.Screen
        name="history/index"
        options={{
          title: tabTitles.history,
          tabBarLabel: tabTitles.history,
          tabBarIcon: ({ color }) => (
            <IconSymbol size={28} name="clock.fill" color={color} />
          ),
        }}
      />

      <Tabs.Screen
        name="history/[id]"
        options={{ href: null }}
      />

      <Tabs.Screen
        name="settings"
        options={{
          title: tabTitles.settings,
          tabBarLabel: tabTitles.settings,
          tabBarIcon: ({ color }) => (
            <IconSymbol size={28} name="gearshape.fill" color={color} />
          ),
        }}
      />

      <Tabs.Screen
        name="pro-insight"
        options={{ href: null }}
      />

      <Tabs.Screen
        name="feedback"
        options={{ href: null }}
      />

      <Tabs.Screen
        name="uncategorized-items"
        options={{ href: null }}
      />
    </Tabs>
  );
}
