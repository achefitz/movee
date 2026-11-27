import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from "@expo-google-fonts/inter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack, useRouter, useSegments } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import React, { useEffect } from "react";
import { View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { AppProvider } from "@/context/AppContext";
import { AuthProvider, useAuth } from "@/context/AuthContext";
import { RecoveryCodeModal } from '@/components/RecoveryCodeModal';
import Colors from "@/constants/colors";

SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient();

function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (isLoading) return;

    const inAuthGroup = segments[0] === 'login' || segments[0] === 'signup' || segments[0] === 'recover';
    const inOnboarding = segments[0] === 'onboarding';

    if (!user && !inAuthGroup) {
      router.replace('/login');
    } else if (user && user.onboarded === false && !inOnboarding) {
      router.replace('/onboarding');
    } else if (user && user.onboarded !== false && (inAuthGroup || inOnboarding)) {
      router.replace('/(tabs)');
    }
  }, [user, isLoading, segments]);

  if (isLoading) {
    return <View style={{ flex: 1, backgroundColor: Colors.bg }} />;
  }

  return <>{children}</>;
}

function AppProviderWithAuth({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  return <AppProvider key={user?.username ?? 'guest'} username={user?.username}>{children}</AppProvider>;
}

function RootLayoutNav() {
  return (
    <AuthProvider>
      <AppProviderWithAuth>
        <AuthGate>
          <Stack screenOptions={{
            headerBackTitle: "Back",
            contentStyle: { backgroundColor: Colors.bg },
          }}>
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen name="login" options={{ headerShown: false, animation: 'fade' }} />
            <Stack.Screen name="signup" options={{ headerShown: false, animation: 'slide_from_right' }} />
            <Stack.Screen name="recover" options={{ headerShown: false, animation: 'slide_from_right' }} />
            <Stack.Screen name="party/[id]" options={{ headerShown: false, animation: 'slide_from_right' }} />
            <Stack.Screen name="user/[username]" options={{ headerShown: false, animation: 'slide_from_right' }} />
            <Stack.Screen name="onboarding" options={{ headerShown: false, animation: 'fade', gestureEnabled: false }} />
          </Stack>
          <RecoveryCodeModal />
        </AuthGate>
      </AppProviderWithAuth>
    </AuthProvider>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <GestureHandlerRootView>
            <KeyboardProvider>
              <RootLayoutNav />
            </KeyboardProvider>
          </GestureHandlerRootView>
        </QueryClientProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
