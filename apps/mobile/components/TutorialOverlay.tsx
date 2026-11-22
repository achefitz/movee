import React, { useState, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Modal,
  Animated, Dimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '@/context/AuthContext';
import Colors from '@/constants/colors';

const { width: W } = Dimensions.get('window');

type IconName = React.ComponentProps<typeof Ionicons>['name'];

type Step = {
  icon: IconName;
  iconColor: string;
  direction: string;
  title: string;
  description: string;
};

const STEPS: Step[] = [
  {
    icon: 'heart',
    iconColor: Colors.like,
    direction: 'Swipe Right',
    title: 'Like it',
    description: 'Swipe right (or tap the heart) to save a movie or show to your watchlist.',
  },
  {
    icon: 'close-circle',
    iconColor: Colors.skip,
    direction: 'Swipe Left',
    title: 'Skip it',
    description: "Swipe left (or tap X) to skip a title — it won't show up again.",
  },
  {
    icon: 'bookmark',
    iconColor: '#7B68EE',
    direction: 'Swipe Up',
    title: 'Add to watchlist',
    description: 'Swipe up to add a title to your watchlist for later, or mark it as already seen.',
  },
  {
    icon: 'volume-mute',
    iconColor: Colors.accent,
    direction: 'Mute button',
    title: 'Trailer audio',
    description: 'Trailers play automatically. Tap the mute icon in the top-right corner to toggle audio.',
  },
];

type TutorialOverlayProps = {
  visible: boolean;
};

export function TutorialOverlay({ visible }: TutorialOverlayProps) {
  const { markTutorialSeen } = useAuth();
  const [stepIndex, setStepIndex] = useState(0);
  const fadeAnim = useRef(new Animated.Value(1)).current;

  const step = STEPS[stepIndex];
  const isLast = stepIndex === STEPS.length - 1;

  const animateToStep = (nextIndex: number) => {
    Animated.timing(fadeAnim, { toValue: 0, duration: 180, useNativeDriver: true }).start(() => {
      setStepIndex(nextIndex);
      Animated.timing(fadeAnim, { toValue: 1, duration: 220, useNativeDriver: true }).start();
    });
  };

  const handleNext = () => {
    if (isLast) {
      markTutorialSeen();
    } else {
      animateToStep(stepIndex + 1);
    }
  };

  const handleSkip = () => {
    markTutorialSeen();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={styles.headerRow}>
            <Text style={styles.headerLabel}>How to swipe</Text>
            <TouchableOpacity onPress={handleSkip} style={styles.skipBtn}>
              <Text style={styles.skipText}>Skip</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.dotsRow}>
            {STEPS.map((_, i) => (
              <View
                key={i}
                style={[styles.dot, i === stepIndex && styles.dotActive]}
              />
            ))}
          </View>

          <Animated.View style={[styles.stepContent, { opacity: fadeAnim }]}>
            <View style={[styles.iconCircle, { borderColor: step.iconColor }]}>
              <Ionicons name={step.icon} size={40} color={step.iconColor} />
            </View>

            <Text style={[styles.directionLabel, { color: step.iconColor }]}>
              {step.direction}
            </Text>
            <Text style={styles.stepTitle}>{step.title}</Text>
            <Text style={styles.stepDescription}>{step.description}</Text>
          </Animated.View>

          <TouchableOpacity
            style={[styles.nextBtn, { backgroundColor: isLast ? Colors.accent : Colors.bgElevated }]}
            onPress={handleNext}
            activeOpacity={0.85}
          >
            {isLast ? (
              <>
                <Text style={[styles.nextBtnText, { color: '#000' }]}>Start swiping!</Text>
                <Ionicons name="rocket" size={18} color="#000" />
              </>
            ) : (
              <>
                <Text style={styles.nextBtnText}>Next</Text>
                <Ionicons name="arrow-forward" size={18} color={Colors.textPrimary} />
              </>
            )}
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.82)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    backgroundColor: Colors.bgCard,
    borderRadius: 28,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 28,
    width: Math.min(W - 48, 380),
    gap: 20,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  headerLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: Colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  skipBtn: { padding: 4 },
  skipText: { color: Colors.textMuted, fontSize: 14, fontWeight: '600' },
  dotsRow: {
    flexDirection: 'row',
    gap: 6,
    justifyContent: 'center',
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: Colors.border,
  },
  dotActive: {
    backgroundColor: Colors.accent,
    width: 20,
    borderRadius: 3,
  },
  stepContent: {
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8,
  },
  iconCircle: {
    width: 88,
    height: 88,
    borderRadius: 44,
    borderWidth: 2,
    backgroundColor: Colors.bgElevated,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  directionLabel: {
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  stepTitle: {
    fontSize: 24,
    fontWeight: '800',
    color: Colors.textPrimary,
    textAlign: 'center',
    fontFamily: 'Inter_700Bold',
  },
  stepDescription: {
    fontSize: 15,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
    fontWeight: '400',
  },
  nextBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 16,
    height: 54,
    marginTop: 4,
  },
  nextBtnText: {
    fontSize: 16,
    fontWeight: '800',
    color: Colors.textPrimary,
    letterSpacing: 0.3,
  },
});
