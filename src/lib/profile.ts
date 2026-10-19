import { useCallback, useEffect, useState } from 'react'

export interface UserProfile {
  displayName: string
  initials: string
}

const PROFILE_STORAGE_KEY = 'cairn.user-profile.v1'
const PROFILE_CHANGE_EVENT = 'cairn:profile-change'
const DEFAULT_PROFILE: UserProfile = { displayName: 'Quentin Chih', initials: 'QC' }
let currentProfile = DEFAULT_PROFILE

function deriveInitials(displayName: string): string {
  return displayName
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.at(0) ?? '')
    .join('')
    .toUpperCase()
    .slice(0, 2) || DEFAULT_PROFILE.initials
}

function normalizeProfile(value: Partial<UserProfile> | undefined): UserProfile {
  const displayName = value?.displayName?.trim() || DEFAULT_PROFILE.displayName
  const initials = value?.initials?.trim().toUpperCase().slice(0, 2) || deriveInitials(displayName)
  return { displayName, initials }
}

function readProfile(): UserProfile {
  if (typeof window === 'undefined') return currentProfile
  try {
    const storedProfile = window.localStorage.getItem(PROFILE_STORAGE_KEY)
    if (storedProfile) currentProfile = normalizeProfile(JSON.parse(storedProfile) as Partial<UserProfile>)
    return currentProfile
  } catch {
    return currentProfile
  }
}

export function useProfile() {
  const [profile, setProfileState] = useState<UserProfile>(readProfile)

  useEffect(() => {
    const syncProfile = (): void => setProfileState(readProfile())
    window.addEventListener(PROFILE_CHANGE_EVENT, syncProfile)
    window.addEventListener('storage', syncProfile)
    return () => {
      window.removeEventListener(PROFILE_CHANGE_EVENT, syncProfile)
      window.removeEventListener('storage', syncProfile)
    }
  }, [])

  const setProfile = useCallback((nextProfile: UserProfile): void => {
    const normalized = normalizeProfile(nextProfile)
    currentProfile = normalized
    setProfileState(normalized)
    try {
      window.localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(normalized))
    } catch {
      // Keep the profile available for this session if storage is unavailable.
    }
    window.dispatchEvent(new Event(PROFILE_CHANGE_EVENT))
  }, [])

  return { profile, setProfile }
}
