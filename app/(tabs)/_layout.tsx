// app/(tabs)/_layout.tsx
import { Tabs } from 'expo-router';
import { getFocusedRouteNameFromRoute } from '@react-navigation/native';
import React, { useEffect, useState } from 'react';

import { HapticTab } from '@/components/haptic-tab';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { subscribeLocaleChange, t } from '@/lib/i18n';
import { TAB_BAR_PRESENTATION } from '@/lib/tabBarPresentation';
import { resolveTabTitles } from '@/lib/tabTitles';

function readTabTitles() {
  return resolveTabTitles(t);
}

const ROOT_TAB_BAR_STYLE = {
  backgroundColor: TAB_BAR_PRESENTATION.background,
  borderTopColor: TAB_BAR_PRESENTATION.border,
};

const HIDDEN_TAB_BAR_STYLE = {
  display: 'none' as const,
};

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
        tabBarStyle: ROOT_TAB_BAR_STYLE,
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

          {/* Nested History stack: index + [id] (edge-swipe + correct goBack) */}
      <Tabs.Screen
        name="history"
        options={({ route }) => {
          const focusedRoute = getFocusedRouteNameFromRoute(route) ?? 'index';
          return {
            title: tabTitles.history,
            tabBarLabel: tabTitles.history,
            tabBarStyle:
              focusedRoute === 'index'
                ? ROOT_TAB_BAR_STYLE
                : HIDDEN_TAB_BAR_STYLE,
            tabBarIcon: ({ color }) => (
              <IconSymbol size={28} name="clock.fill" color={color} />
            ),
          };
        }}
      />

      {/* Nested Stack: settings/index + subordinate pages */}
      <Tabs.Screen
        name="settings"
        options={({ route }) => {
          const focusedRoute = getFocusedRouteNameFromRoute(route) ?? 'index';
          return {
            title: tabTitles.settings,
            tabBarLabel: tabTitles.settings,
            tabBarStyle:
              focusedRoute === 'index'
                ? ROOT_TAB_BAR_STYLE
                : HIDDEN_TAB_BAR_STYLE,
            tabBarIcon: ({ color }) => (
              <IconSymbol size={28} name="gearshape.fill" color={color} />
            ),
          };
        }}
      />
    </Tabs>
  );
}
